require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { fal } = require('@fal-ai/client');

fal.config({ credentials: process.env.FAL_KEY });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const app = express();
app.use('/webhook/nowpayments', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors());

const CREDIT_COST_PER_SECOND = 1;

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'مطلوب تسجيل دخول' });
  }
  const token = header.split(' ')[1];
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: 'الجلسة منتهية، سجل دخولك مرة ثانية' });
  }
  req.user = data.user;
  next();
}

app.get('/me', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('email, credits, plan')
    .eq('id', req.user.id)
    .single();
  if (error) return res.status(404).json({ error: 'المستخدم غير موجود' });
  res.json(data);
});

app.post('/generate', authMiddleware, async (req, res) => {
  try {
    const { prompt, duration, quality, ratio } = req.body;
    if (!prompt) return res.status(400).json({ error: 'اكتب وصف الفيديو' });

    const cost = Number(duration) * CREDIT_COST_PER_SECOND;

    const { data: profile } = await supabase
      .from('profiles')
      .select('credits')
      .eq('id', req.user.id)
      .single();

    if (!profile || profile.credits < cost) {
      return res.status(402).json({ error: 'رصيدك غير كافي، تحتاج تشحن رصيد' });
    }

    const { data: video } = await supabase
      .from('videos')
      .insert({ user_id: req.user.id, prompt, duration, quality, ratio, status: 'pending' })
      .select()
      .single();

    const result = await fal.subscribe('fal-ai/veo3.1', {
      input: { prompt, aspect_ratio: ratio },
    });

    const videoUrl = result.data.video.url;

    await supabase.from('profiles').update({ credits: profile.credits - cost }).eq('id', req.user.id);
    await supabase.from('videos').update({ video_url: videoUrl, status: 'done' }).eq('id', video.id);

    res.json({ video_url: videoUrl, remaining_credits: profile.credits - cost });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل توليد الفيديو، حاول مرة ثانية' });
  }
});

app.post('/checkout', authMiddleware, async (req, res) => {
  try {
    const { amount_usd } = req.body;
    const response = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        price_amount: amount_usd,
        price_currency: 'usd',
        order_id: req.user.id,
        order_description: 'VISKAI credits top-up',
        ipn_callback_url: `${req.protocol}://${req.get('host')}/webhook/nowpayments`,
      }),
    });
    const data = await response.json();
    res.json({ checkout_url: data.invoice_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر إنشاء رابط الدفع' });
  }
});

app.post('/webhook/nowpayments', async (req, res) => {
  try {
    const signature = req.headers['x-nowpayments-sig'];
    const params = JSON.parse(req.body.toString());

    const sortedParams = {};
    Object.keys(params).sort().forEach((key) => { sortedParams[key] = params[key]; });
    const hmac = crypto.createHmac('sha512', process.env.NOWPAYMENTS_IPN_SECRET);
    hmac.update(JSON.stringify(sortedParams));
    const digest = hmac.digest('hex');

    if (signature !== digest) {
      return res.status(401).json({ error: '�
