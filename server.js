const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const META_ACCESS_TOKEN = (process.env.META_ACCESS_TOKEN || '').trim();
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || 'mvt_webhook_2026').trim();
const IG_USER_ID = (process.env.IG_USER_ID || '').trim();

const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const DEFAULT_STATE = {
  mode: META_ACCESS_TOKEN ? 'production' : 'simulation',
  stats: {
    commentsReplied: 0,
    storiesReplied: 0,
    dmsSent: 0
  },
  automations: [
    {
      id: 'auto_1',
      type: 'comment',
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
  contacts: []
};

function loadInitialState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        mode: parsed.mode === 'simulation' || parsed.mode === 'production'
          ? parsed.mode
          : (META_ACCESS_TOKEN ? 'production' : 'simulation'),
        stats: {
          commentsReplied: Number(parsed.stats?.commentsReplied || 0),
          storiesReplied: Number(parsed.stats?.storiesReplied || 0),
          dmsSent: Number(parsed.stats?.dmsSent || 0)
        },
        automations: Array.isArray(parsed.automations) ? parsed.automations : [],
        flows: Array.isArray(parsed.flows) ? parsed.flows : DEFAULT_STATE.flows,
        contacts: Array.isArray(parsed.contacts) ? parsed.contacts : []
      };
    }
  } catch (err) {
    console.error('Erro ao carregar state.json, usando estado padrão:', err.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

const state = loadInitialState();

function persistState() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('Erro ao salvar state.json:', err.message);
  }
}

// Deduplicação simples de eventos recentes (evita disparo duplo em reenvios da Meta)
const recentEventIds = new Map();
function isDuplicateEvent(eventId) {
  if (!eventId) return false;
  const now = Date.now();
  // Limpa entradas com mais de 10 minutos
  for (const [key, ts] of recentEventIds.entries()) {
    if (now - ts > 10 * 60 * 1000) recentEventIds.delete(key);
  }
  if (recentEventIds.has(eventId)) return true;
  recentEventIds.set(eventId, now);
  return false;
}

// Retorna apenas automações válidas, ativas e com palavra-chave não vazia
function getValidAutomationsByType(type) {
  return (state.automations || []).filter(a => {
    if (!a || a.active !== true || a.type !== type) return false;
    const kw = String(a.keyword || '').trim();
    if (kw.length === 0) return false;
    const hasFlow = Boolean(a.flowId && (state.flows || []).some(f => f.id === a.flowId));
    const hasText = Boolean(String(a.dmText || '').trim() || String(a.publicReply || '').trim());
    return hasFlow || hasText;
  });
}

// Registra contato na janela de 24h
function upsertContact(id, username = 'Seguidor') {
  if (!id) return;
  const cleanId = String(id).trim();
  if (!cleanId) return;
  const now = Date.now();
  const idx = state.contacts.findIndex(c => String(c.id) === cleanId);
  if (idx >= 0) {
    state.contacts[idx].lastInteraction = now;
    if (username && username !== 'Seguidor') state.contacts[idx].username = username;
  } else {
    state.contacts.unshift({ id: cleanId, username, lastInteraction: now });
  }
  persistState();
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
  const cleanMsg = String(message || '').trim();
  if (!commentId || !cleanMsg) return;
  await metaPost(`${commentId}/replies`, { message: cleanMsg });
  state.stats.commentsReplied++;
  persistState();
}

async function sendDM(recipient, text, buttons = []) {
  const cleanText = String(text || '').trim();
  if (!recipient || !cleanText) return;

  const recipientObj = typeof recipient === 'string' ? { id: recipient } : recipient;
  const payload = {
    recipient: recipientObj,
    message: { text: cleanText }
  };

  if (buttons && buttons.length > 0) {
    payload.message.quick_replies = buttons.slice(0, 3).map(btn => ({
      content_type: 'text',
      title: String(btn.title || '').slice(0, 20),
      payload: `FLOW_STEP:${btn.nextStepId}`
    }));
  }

  const senderEndpoint = IG_USER_ID ? `${IG_USER_ID}/messages` : 'me/messages';
  await metaPost(senderEndpoint, payload);
  state.stats.dmsSent++;
  persistState();
}

async function sendFlowStep(recipient, flowId, stepId) {
  if (!flowId) return;
  const flow = (state.flows || []).find(f => f.id === flowId);
  if (!flow || !Array.isArray(flow.steps) || flow.steps.length === 0) return;
  const step = stepId ? flow.steps.find(s => s.id === stepId) : flow.steps[0];
  if (!step || !String(step.message || '').trim()) return;
  await sendDM(recipient, step.message, step.buttons || []);
}

async function processIncomingMessageEvent(msgEvent) {
  const senderId = String(msgEvent?.sender?.id || '').trim();
  if (!senderId || (IG_USER_ID && senderId === IG_USER_ID)) return;
  if (msgEvent?.message?.is_echo) return;

  const mid = msgEvent?.message?.mid;
  if (mid && isDuplicateEvent(`msg:${mid}`)) {
    console.log(`⏭️ Evento duplicado ignorado (${mid})`);
    return;
  }

  upsertContact(senderId);

  // Clique em botão de fluxo (Quick Reply)
  const qrPayload = msgEvent?.message?.quick_reply?.payload;
  if (qrPayload && qrPayload.startsWith('FLOW_STEP:')) {
    const targetStepId = qrPayload.replace('FLOW_STEP:', '');
    for (const flow of state.flows || []) {
      const step = (flow.steps || []).find(s => s.id === targetStepId);
      if (step) {
        await sendDM(senderId, step.message, step.buttons || []);
        break;
      }
    }
    return;
  }

  const rawText = String(msgEvent?.message?.text || '').trim().toUpperCase();
  if (!rawText) return;

  const isStoryReply = Boolean(
    msgEvent?.message?.reply_to?.story ||
    (msgEvent?.message?.attachments || []).some(a => a.type === 'story_mention')
  );

  const targetType = isStoryReply ? 'story' : 'dm';
  const activeRules = getValidAutomationsByType(targetType);

  if (activeRules.length === 0) {
    console.log(`ℹ️ Nenhum gatilho ativo de ${targetType} para "${rawText}". Nenhuma mensagem enviada.`);
    return;
  }

  const rule = activeRules.find(a => {
    const kw = String(a.keyword || '').trim().toUpperCase();
    return kw.length > 0 && rawText.includes(kw);
  });

  if (!rule) {
    console.log(`ℹ️ Mensagem de ${senderId} ("${rawText}") não corresponde a nenhum gatilho ativo de ${targetType}.`);
    return;
  }

  console.log(`📩 ${isStoryReply ? 'Story' : 'DM'} capturada de ${senderId} | Gatilho: ${rule.keyword}`);
  if (isStoryReply) {
    state.stats.storiesReplied++;
    persistState();
  }
  if (String(rule.dmText || '').trim()) {
    await sendDM(senderId, rule.dmText);
  }
  if (rule.flowId) {
    await sendFlowStep(senderId, rule.flowId);
  }
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
  console.log('📥 Webhook recebido:', JSON.stringify(req.body));
  if (state.mode !== 'production') return;

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      // 1. Comentários em Posts/Reels e eventuais mensagens via changes
      for (const change of entry.changes || []) {
        if (change.field === 'comments') {
          const val = change.value || {};
          const fromId = String(val.from?.id || '').trim();
          const username = val.from?.username || 'Seguidor';
          const rawText = String(val.text || '').trim().toUpperCase();
          const commentId = String(val.id || '').trim();

          if (!fromId || (IG_USER_ID && fromId === IG_USER_ID)) continue;
          if (!rawText) continue;

          if (commentId && isDuplicateEvent(`comment:${commentId}`)) {
            console.log(`⏭️ Comentário duplicado ignorado (${commentId})`);
            continue;
          }

          upsertContact(fromId, username);

          const activeCommentRules = getValidAutomationsByType('comment');
          if (activeCommentRules.length === 0) {
            console.log(`ℹ️ Nenhum gatilho ativo de comment para comentário de @${username}. Nenhuma ação tomada.`);
            continue;
          }

          const rule = activeCommentRules.find(a => {
            const kw = String(a.keyword || '').trim().toUpperCase();
            return kw.length > 0 && rawText.includes(kw);
          });

          if (!rule) {
            console.log(`ℹ️ Comentário de @${username} ("${rawText}") não corresponde a nenhum gatilho ativo.`);
            continue;
          }

          console.log(`💬 Comentário capturado de @${username} | Gatilho: ${rule.keyword}`);
          if (String(rule.publicReply || '').trim() && commentId) {
            await replyComment(commentId, rule.publicReply);
          }
          if (String(rule.dmText || '').trim()) {
            await sendDM(commentId ? { comment_id: commentId } : fromId, rule.dmText);
          }
          if (rule.flowId) {
            await sendFlowStep(fromId, rule.flowId);
          }
        } else if (change.field === 'messages' && change.value) {
          await processIncomingMessageEvent(change.value);
        }
      }

      // 2. DMs, Respostas a Stories e Cliques em Fluxos
      for (const msgEvent of entry.messaging || []) {
        await processIncomingMessageEvent(msgEvent);
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
      activeAutomations: getValidAutomationsByType('comment').length +
        getValidAutomationsByType('story').length +
        getValidAutomationsByType('dm').length,
      active24hContacts: getActive24hContacts().length
    },
    automations: state.automations,
    flows: state.flows,
    contacts: getActive24hContacts()
  });
});

app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  if (mode === 'simulation' || mode === 'production') {
    state.mode = mode;
    persistState();
  }
  res.json({ mode: state.mode });
});

app.post('/api/automations', (req, res) => {
  const type = String(req.body?.type || '').trim();
  const keyword = String(req.body?.keyword || '').trim().toUpperCase();
  const publicReply = String(req.body?.publicReply || '').trim();
  const dmText = String(req.body?.dmText || '').trim();
  const flowId = String(req.body?.flowId || '').trim();

  if (!['comment', 'story', 'dm'].includes(type)) {
    return res.status(400).json({ error: 'Tipo de gatilho inválido (use comment, story ou dm).' });
  }
  if (!keyword) {
    return res.status(400).json({ error: 'A palavra-chave é obrigatória para evitar disparos indevidos.' });
  }
  if (!publicReply && !dmText && !flowId) {
    return res.status(400).json({ error: 'Informe uma resposta pública, mensagem no Direct ou fluxo.' });
  }

  const item = {
    id: 'auto_' + Date.now(),
    type,
    keyword,
    publicReply,
    dmText,
    flowId,
    active: req.body?.active !== false
  };
  state.automations.unshift(item);
  persistState();
  res.json(item);
});

app.delete('/api/automations/:id', (req, res) => {
  const targetId = String(req.params.id || '').trim();
  const beforeCount = state.automations.length;
  state.automations = state.automations.filter(a => String(a.id) !== targetId);

  if (state.automations.length === beforeCount) {
    return res.status(404).json({ ok: false, error: 'Gatilho não encontrado.' });
  }

  persistState();
  res.json({ ok: true, remaining: state.automations.length });
});

app.post('/api/flows', (req, res) => {
  const flow = { id: 'flow_' + Date.now(), ...req.body };
  state.flows.unshift(flow);
  persistState();
  res.json(flow);
});

app.delete('/api/flows/:id', (req, res) => {
  const targetId = String(req.params.id || '').trim();
  state.flows = state.flows.filter(f => String(f.id) !== targetId);
  persistState();
  res.json({ ok: true });
});

app.post('/api/broadcast', async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) {
    return res.status(400).json({ error: 'Mensagem de broadcast não pode estar vazia.' });
  }
  const targets = getActive24hContacts();
  if (state.mode === 'production') {
    for (const contact of targets) {
      await sendDM(contact.id, message);
    }
  } else {
    state.stats.dmsSent += targets.length;
    persistState();
  }
  res.json({ sent: targets.length, mode: state.mode });
});

app.listen(PORT, () => {
  console.log(`🚀 InstaFlow Studio rodando na porta ${PORT} | Modo: ${state.mode} | Gatilhos carregados: ${state.automations.length}`);
});
