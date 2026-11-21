const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const META_ACCESS_TOKEN = (process.env.META_ACCESS_TOKEN || '').trim();
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || 'mvt_webhook_2026').trim();
const IG_USER_ID = (process.env.IG_USER_ID || '').trim();

// --- BANCO DE DADOS EM MEMÓRIA ---
const state = {
  mode: META_ACCESS_TOKEN ? 'production' : 'simulation',
  stats: {
    commentsReplied: 0,
    storiesReplied: 0,
    dmsSent: 0
  },
  automations: [
    {
      id: 'auto_1',
      type: 'comment', // comment | story | dm
      keyword: 'QUERO',
      publicReply: 'Te enviei as informações no Direct! 😊',
      dmText: 'Olá! Vi seu comentário. Clique abaixo para escolher o que você precisa:',
      flowId: 'flow_1',
      active: true
    },
    {
      id: 'auto_2',
      type: 'story',
      keyword: 'EU QUERO',
      publicReply: '',
      dmText: 'Obrigada por responder meu Story! Segue o acesso:',
      flowId: '',
      active: true
    },
    {
      id: 'auto_3',
      type: 'dm',
      keyword: 'PRECO',
      publicReply: '',
      dmText: 'Nossos planos começam a partir de R$ 97. Quer ver os detalhes?',
      flowId: 'flow_1',
      active: true
    }
  ],
  flows: [
    {
      id: 'flow_1',
      name: 'Fluxo de Boas-Vindas e Oferta',
      steps: [
        {
          id: 'step_1',
          message: 'Como posso te ajudar hoje? Escolha uma opção:',
          buttons: [
            { title: 'Ver Oferta', nextStepId: 'step_2' },
            { title: 'Falar com Suporte', nextStepId: 'step_3' }
          ]
        },
        {
          id: 'step_2',
          message: 'Perfeito! Acesse a oferta completa aqui: https://mentoriamvt.com/',
          buttons: []
        },
        {
          id: 'step_3',
          message: 'Certo! Já avisei nossa equipe e logo responderemos por aqui.',
          buttons: []
        }
      ]
    }
  ],
  contacts: [] // { id, username, lastInteraction }
};

// Registra contato na janela de 24h
function upsertContact(id, username = 'Seguidor') {
  if (!id) return;
  const now = Date.now();
  const idx = state.contacts.findIndex(c => c.id === id);
  if (idx >= 0) {
    state.contacts[idx].lastInteraction = now;
    if (username && username !== 'Seguidor') state.contacts[idx].username = username;
  } else {
    state.contacts.unshift({ id, username, lastInteraction: now });
  }
}

function getActive24hContacts() {
  const limit = Date.now() - 24 * 60 * 60 * 1000;
  return state.contacts.filter(c => c.lastInteraction >= limit);
}

// --- FUNÇÕES DA API OFICIAL DA META ---
async function metaPost(endpoint, body) {
  if (!META_ACCESS_TOKEN) return { skipped: true, reason: 'Sem META_ACCESS_TOKEN' };
  const apiBase = META_ACCESS_TOKEN.startsWith('IG')
    ? 'https://graph.instagram.com/v21.0'
    : 'https://graph.facebook.com/v21.0';
  const url = `${apiBase}/${endpoint}?access_token=${encodeURIComponent(META_ACCESS_TOKEN)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) console.error('Erro Meta API:', JSON.stringify(data));
  return data;
}

async function replyComment(commentId, message) {
  if (!message) return;
  await metaPost(`${commentId}/replies`, { message });
  state.stats.commentsReplied++;
}

async function sendDM(recipient, text, buttons = []) {
  const recipientObj = typeof recipient === 'string' ? { id: recipient } : recipient;
  const payload = {
    recipient: recipientObj,
    message: { text }
  };

  if (buttons && buttons.length > 0) {
    payload.message.quick_replies = buttons.slice(0, 3).map(btn => ({
      content_type: 'text',
      title: btn.title.slice(0, 20),
      payload: `FLOW_STEP:${btn.nextStepId}`
    }));
  }

  await metaPost('me/messages', payload);
  state.stats.dmsSent++;
}

async function sendFlowStep(recipient, flowId, stepId) {
  const flow = state.flows.find(f => f.id === flowId);
  if (!flow) return;
  const step = stepId ? flow.steps.find(s => s.id === stepId) : flow.steps[0];
  if (!step) return;
  await sendDM(recipient, step.message, step.buttons || []);
}

// --- WEBHOOK META ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado pela Meta');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  if (state.mode !== 'production') return;

  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      // 1. Comentários em Posts e Reels
      for (const change of entry.changes || []) {
        if (change.field === 'comments') {
          const val = change.value || {};
          const fromId = val.from?.id;
          const username = val.from?.username || 'Seguidor';
          const text = (val.text || '').toUpperCase();
          const commentId = val.id;

          if (!fromId || fromId === IG_USER_ID) continue;
          upsertContact(fromId, username);

          const rule = state.automations.find(
            a => a.active && a.type === 'comment' && text.includes(a.keyword.toUpperCase())
          );

          if (rule) {
            console.log(`💬 Comentário capturado de @${username}: ${val.text}`);
            if (rule.publicReply) await replyComment(commentId, rule.publicReply);
            if (rule.dmText) await sendDM({ comment_id: commentId }, rule.dmText);
            if (rule.flowId) await sendFlowStep(fromId, rule.flowId);
          }
        }
      }

      // 2. DMs, Respostas a Stories e Cliques em Fluxos
      for (const msgEvent of entry.messaging || []) {
        const senderId = msgEvent.sender?.id;
        if (!senderId || senderId === IG_USER_ID) continue;
        if (msgEvent.message?.is_echo) continue;

        upsertContact(senderId);

        // Clique em botão de fluxo (Quick Reply)
        const qrPayload = msgEvent.message?.quick_reply?.payload;
        if (qrPayload && qrPayload.startsWith('FLOW_STEP:')) {
          const targetStepId = qrPayload.replace('FLOW_STEP:', '');
          for (const flow of state.flows) {
            const step = flow.steps.find(s => s.id === targetStepId);
            if (step) {
              await sendDM(senderId, step.message, step.buttons || []);
              break;
            }
          }
          continue;
        }

        const text = (msgEvent.message?.text || '').toUpperCase();
        const isStoryReply = Boolean(
          msgEvent.message?.reply_to?.story ||
          (msgEvent.message?.attachments || []).some(a => a.type === 'story_mention')
        );

        const targetType = isStoryReply ? 'story' : 'dm';
        const rule = state.automations.find(
          a => a.active && a.type === targetType && (!a.keyword || text.includes(a.keyword.toUpperCase()))
        );

        if (rule) {
          console.log(`📩 ${isStoryReply ? 'Story' : 'DM'} capturada de ${senderId}`);
          if (isStoryReply) state.stats.storiesReplied++;
          if (rule.dmText) await sendDM(senderId, rule.dmText);
          if (rule.flowId) await sendFlowStep(senderId, rule.flowId);
        }
      }
    }
  } catch (err) {
    console.error('Erro ao processar webhook:', err);
  }
});

// --- API DO PAINEL ---
app.get('/api/state', (req, res) => {
  res.json({
    tokenConnected: Boolean(META_ACCESS_TOKEN),
    mode: state.mode,
    stats: {
      ...state.stats,
      activeFlows: state.flows.length,
      activeAutomations: state.automations.filter(a => a.active).length,
      active24hContacts: getActive24hContacts().length
    },
    automations: state.automations,
    flows: state.flows,
    contacts: getActive24hContacts()
  });
});

app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  if (mode === 'simulation' || mode === 'production') state.mode = mode;
  res.json({ mode: state.mode });
});

app.post('/api/automations', (req, res) => {
  const item = { id: 'auto_' + Date.now(), active: true, ...req.body };
  state.automations.unshift(item);
  res.json(item);
});

app.delete('/api/automations/:id', (req, res) => {
  state.automations = state.automations.filter(a => a.id !== req.params.id);
  res.json({ ok: true });
});

app.post('/api/flows', (req, res) => {
  const flow = { id: 'flow_' + Date.now(), ...req.body };
  state.flows.unshift(flow);
  res.json(flow);
});

app.delete('/api/flows/:id', (req, res) => {
  state.flows = state.flows.filter(f => f.id !== req.params.id);
  res.json({ ok: true });
});

app.post('/api/broadcast', async (req, res) => {
  const { message } = req.body;
  const targets = getActive24hContacts();
  if (state.mode === 'production') {
    for (const contact of targets) {
      await sendDM(contact.id, message);
    }
  } else {
    state.stats.dmsSent += targets.length;
  }
  res.json({ sent: targets.length, mode: state.mode });
});

app.listen(PORT, () => {
  console.log(`🚀 InstaFlow Studio rodando na porta ${PORT}`);
});
