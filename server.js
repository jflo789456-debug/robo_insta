const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'mvt_webhook_2026';
const IG_USER_ID = process.env.IG_USER_ID || '17841440156916340';
const DATA_FILE = path.join(__dirname, 'data.json');

// Carrega ou inicializa dados locais (regras e contatos 24h)
let db = {
  rules: [
    {
      id: 1,
      type: 'comment',
      keyword: 'QUERO',
      publicReply: 'Te enviei as informações no Direct! Dá uma olhada lá 😉',
      dmText: 'Olá! Aqui está o link que você pediu no comentário:',
      buttonText: 'Acessar agora',
      buttonUrl: 'https://instagram.com',
      active: true
    },
    {
      id: 2,
      type: 'dm',
      keyword: 'PRECO',
      publicReply: '',
      dmText: 'Oi! Nossos planos e valores estão disponíveis no link abaixo:',
      buttonText: 'Ver tabela',
      buttonUrl: 'https://instagram.com',
      active: true
    }
  ],
  contacts: []
};

if (fs.existsSync(DATA_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Erro ao ler data.json:', e.message);
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Erro ao salvar data.json:', e.message);
  }
}

function upsertContact(igScopedId, username = 'Usuário Instagram') {
  const now = new Date().toISOString();
  const idx = db.contacts.findIndex(c => c.id === igScopedId);
  if (idx >= 0) {
    db.contacts[idx].lastInteraction = now;
    if (username && username !== 'Usuário Instagram') db.contacts[idx].username = username;
  } else {
    db.contacts.unshift({ id: igScopedId, username, lastInteraction: now });
  }
  saveDb();
}

async function metaPost(endpoint, body) {
  if (!META_ACCESS_TOKEN) {
    console.warn('⚠️ META_ACCESS_TOKEN não configurado nas variáveis de ambiente.');
    return { error: 'META_ACCESS_TOKEN não configurado' };
  }
  const url = `https://graph.facebook.com/v21.0/${endpoint}?access_token=${encodeURIComponent(META_ACCESS_TOKEN)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) console.error('Erro Meta API:', data);
  return data;
}

async function sendDm(recipientId, text, buttonText, buttonUrl) {
  const message = (buttonText && buttonUrl)
    ? {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text,
            buttons: [{ type: 'web_url', url: buttonUrl, title: buttonText }]
          }
        }
      }
    : { text };

  return metaPost(`${IG_USER_ID}/messages`, {
    recipient: { id: recipientId },
    message
  });
}

// ==========================================
// 1. WEBHOOK DA META (GET = Verificação, POST = Eventos)
// ==========================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado pela Meta!');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object !== 'instagram') return res.sendStatus(404);

  res.status(200).send('EVENT_RECEIVED');

  for (const entry of body.entry || []) {
    // Eventos de Comentários (Posts / Reels)
    for (const change of entry.changes || []) {
      if (change.field === 'comments' && change.value) {
        const { id: commentId, text = '', from = {} } = change.value;
        if (!from.id || from.id === IG_USER_ID) continue;

        const lowerText = text.toLowerCase();
        const rule = db.rules.find(
          r => r.active && r.type === 'comment' && lowerText.includes(r.keyword.toLowerCase())
        );

        if (rule) {
          console.log(`💬 Comentário capturado de @${from.username}: "${text}"`);
          if (rule.publicReply) {
            await metaPost(`${commentId}/replies`, { message: rule.publicReply });
          }
          if (rule.dmText) {
            await metaPost(`${IG_USER_ID}/messages`, {
              recipient: { comment_id: commentId },
              message: { text: rule.dmText + (rule.buttonUrl ? `\n${rule.buttonUrl}` : '') }
            });
          }
        }
      }
    }

    // Eventos de Mensagens Diretas (DM / Resposta de Story)
    for (const event of entry.messaging || []) {
      const senderId = event.sender && event.sender.id;
      if (!senderId || senderId === IG_USER_ID) continue;
      if (event.message && event.message.is_echo) continue;

      upsertContact(senderId);

      const text = (event.message && event.message.text) || '';
      if (!text) continue;

      const lowerText = text.toLowerCase();
      const rule = db.rules.find(
        r => r.active && r.type === 'dm' && lowerText.includes(r.keyword.toLowerCase())
      );

      if (rule) {
        console.log(`📩 DM capturada de ${senderId}: "${text}"`);
        await sendDm(senderId, rule.dmText, rule.buttonText, rule.buttonUrl);
      }
    }
  }
});

// ==========================================
// 2. API INTERNA DO PAINEL WEB
// ==========================================
app.get('/api/status', (req, res) => {
  res.json({
    online: true,
    tokenConfigured: Boolean(META_ACCESS_TOKEN),
    verifyToken: WEBHOOK_VERIFY_TOKEN,
    igUserId: IG_USER_ID,
    rulesCount: db.rules.length,
    contactsCount: db.contacts.length
  });
});

app.get('/api/rules', (req, res) => res.json(db.rules));

app.post('/api/rules', (req, res) => {
  const newRule = { id: Date.now(), active: true, ...req.body };
  db.rules.unshift(newRule);
  saveDb();
  res.json(newRule);
});

app.delete('/api/rules/:id', (req, res) => {
  db.rules = db.rules.filter(r => String(r.id) !== String(req.params.id));
  saveDb();
  res.json({ ok: true });
});

app.get('/api/contacts', (req, res) => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const active24h = db.contacts.filter(c => new Date(c.lastInteraction).getTime() >= cutoff);
  res.json(active24h);
});

app.post('/api/broadcast', async (req, res) => {
  const { text, buttonText, buttonUrl } = req.body;
  if (!text) return res.status(400).json({ error: 'Texto obrigatório' });

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const targets = db.contacts.filter(c => new Date(c.lastInteraction).getTime() >= cutoff);
  let sent = 0;

  for (const c of targets) {
    const result = await sendDm(c.id, text, buttonText, buttonUrl);
    if (!result.error) sent++;
  }
  res.json({ total: targets.length, sent });
});

app.listen(PORT, () => {
  console.log(`🚀 InstaFlow Studio rodando na porta ${PORT}`);
});
