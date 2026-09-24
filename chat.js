// netlify/functions/chat.js
// Função serverless: recebe a mensagem do app Nexa, chama a Groq usando a
// chave guardada em segredo (variável de ambiente GROQ_API_KEY) e devolve
// só o texto da resposta. A chave nunca é exposta ao navegador do usuário.
//
// SEGURANÇA: o limite de mensagens grátis é controlado AQUI (servidor), usando
// o Netlify Blobs, e não só no localStorage do navegador — assim ele não pode
// ser burlado limpando o site data ou chamando a function direto.

const { getStore } = require('@netlify/blobs');

const MODEL = 'openai/gpt-oss-20b';
const FREQS = ['Todos os dias', 'Segunda a sexta', '3x por semana', '2x por semana', '1x por semana'];

// Limites de uso. DAILY é por conta (e-mail); MINUTE é por IP, para conter
// picos de abuso mesmo se alguém forjar um e-mail que não é seu.
const DAILY_LIMIT = 8;
const MINUTE_LIMIT = 6;

function buildSystemPrompt({ userName, habits, goals, health }) {
  const name = (userName || 'usuário').toString().slice(0, 60);
  const habitsStr = Array.isArray(habits) && habits.length
    ? habits.slice(0, 30).map(h => String(h).slice(0, 80)).join('; ')
    : 'nenhum';
  const goalsStr = Array.isArray(goals) && goals.length
    ? goals.slice(0, 30).map(g => String(g).slice(0, 80)).join('; ')
    : 'nenhuma';
  const healthStr = (typeof health === 'string' && health.trim())
    ? health.trim().slice(0, 300)
    : 'sem dados registrados';

  return `Você é a Nexa AI, a mentora de hábitos, rotinas, treinos e produtividade do app Nexa. Responda em português do Brasil (ou no idioma do usuário), com tom caloroso, direto e motivador. Responda qualquer pedido do usuário, mesmo fora do tema, e ajude com o uso do app.
CRIAR HÁBITOS: quando o usuário quiser criar ou melhorar um hábito, entregue um plano prático e curto: versão mínima para começar, dias e horários sugeridos, um gatilho ("depois de X, eu faço Y"), 2 a 3 dicas para manter e como acompanhar no app. Termine confirmando com a identidade Nexa: "✅ Hábito confirmado na Nexa: <resumo em uma linha>" e, na ÚLTIMA linha da resposta, escreva a etiqueta [[HABITO|título curto|meta numérica por dia|unidade|frequência|categoria]]. Unidades: km, min, horas, vezes, copos, páginas. Frequências: ${FREQS.join(', ')} (4 ou 5 vezes = Segunda a sexta). Categorias: Saúde, Estudo, Lazer, Outros. Use a etiqueta só ao propor um hábito novo e nunca a explique.
TREINOS PERSONALIZADOS: se o usuário pedir um treino, e faltar objetivo (emagrecer, ganhar massa, condicionamento, saúde geral), nível (iniciante/intermediário/avançado) ou dias disponíveis por semana, pergunte só o que faltar antes de montar o plano. Depois monte a divisão por dia usando uma tabela markdown (colunas: Dia | Foco | Exercícios) ou lista numerada por dia, com séries e repetições. Sugira registrar os treinos no app em Saúde → Exercícios.
PERCENTUAL DE GORDURA: se o usuário pedir estimativa de percentual de gordura, use o método da Marinha dos EUA. Peça o que faltar: sexo biológico, altura, e circunferências em cm de pescoço e cintura (mulheres: também quadril). Calcule com as fórmulas: homens → %BF = 495/(1.0324-0.19077*log10(cintura-pescoço)+0.15456*log10(altura))-450; mulheres → %BF = 495/(1.29579-0.35004*log10(cintura+quadril-pescoço)+0.22100*log10(altura))-450. Mostre o resultado arredondado e deixe claro que é uma estimativa, não substitui avaliação profissional (bioimpedância, dobras cutâneas ou DEXA). Sugira registrar o peso e as medidas no app em Saúde → Corpo.
DADOS DE SAÚDE DO USUÁRIO (use quando fizer sentido, não repita se não for perguntado): ${healthStr}.
SOBRE O APP: Início (saldo e resumo da semana), Metas (valor e progresso), Hábitos (meta diária, marcar progresso, frequência), Finanças (entradas e saídas, pessoal ou empresa; assinaturas viram saídas automaticamente no dia da cobrança), Saúde (Refeições, Água, Treinos e Corpo — peso e medidas), Notas (checklists com [ ], cores, fixar, busca) e Nexa AI (este chat). O botão + cria itens, o menu inferior troca de tela e o backup fica em "Minha conta" (toque no avatar no topo do Início). Se não tiver certeza de algo do app, diga.
Seja concisa, use listas curtas, tabelas quando ajudar a organizar informação, e poucos emojis. Você não vê as finanças do usuário. Não peça senhas nem dados sensíveis além de medidas corporais quando o próprio usuário pedir cálculo de % de gordura.
Usuário: ${name}. Hábitos atuais: ${habitsStr}. Metas: ${goalsStr}.`;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function clientIp(event) {
  const h = event.headers || {};
  return (h['x-nf-client-connection-ip'] || h['client-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();
}

// Conta simples: lê, incrementa, grava. Não é atômico (não há lock), então em
// picos muito raros duas requisições quase simultâneas podem passar do limite
// por 1. É aceitável aqui — o objetivo é impedir abuso continuado, não ser
// um rate limiter de grau bancário.
async function checkAndBump(store, key, limit) {
  let rec = { count: 0 };
  try {
    rec = (await store.get(key, { type: 'json' })) || { count: 0 };
  } catch (e) {
    rec = { count: 0 };
  }
  if (rec.count >= limit) return { ok: false, count: rec.count };
  rec.count += 1;
  try {
    await store.setJSON(key, rec);
  } catch (e) {
    // Se o Blobs falhar, deixamos passar (fail-open) em vez de derrubar o
    // chat inteiro por causa de uma falha de infraestrutura secundária.
  }
  return { ok: true, count: rec.count };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Método não permitido.' }) };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GROQ_API_KEY não configurada no Netlify.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'JSON inválido.' }) };
  }

  const { messages, userName, habits, goals, health, email } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Nenhuma mensagem enviada.' }) };
  }

  // --- Rate limiting no servidor (não confia no contador do navegador) ---
  let store;
  try {
    store = getStore('nexa-ai-usage');
  } catch (e) {
    store = null;
  }

  if (store) {
    const ip = clientIp(event);
    const day = todayKey();

    // Limite por minuto e por IP — contém picos/abuso automatizado.
    const minuteBucket = Math.floor(Date.now() / 60000);
    const minuteKey = `ip:${ip}:${minuteBucket}`;
    const minuteCheck = await checkAndBump(store, minuteKey, MINUTE_LIMIT);
    if (!minuteCheck.ok) {
      return {
        statusCode: 429,
        body: JSON.stringify({ error: 'Muitas mensagens em pouco tempo. Aguarde um instante e tente de novo.' })
      };
    }

    // Limite diário por conta (quando o app manda o e-mail do usuário logado).
    const emailKey = (typeof email === 'string' && email.trim())
      ? `user:${email.trim().toLowerCase()}:${day}`
      : `ip:${ip}:${day}`; // sem conta identificada, cai para limite por IP/dia
    const dailyCheck = await checkAndBump(store, emailKey, DAILY_LIMIT);
    if (!dailyCheck.ok) {
      return {
        statusCode: 429,
        body: JSON.stringify({ error: 'Limite diário de mensagens grátis atingido. Volte amanhã.' })
      };
    }
  }

  // Sanitiza e limita o histórico — nunca confie em dados vindos do cliente.
  // Também garante que os papéis alternem e comecem em "user", que é o que a
  // API da Groq espera; descarta mensagens fora de ordem em vez de falhar.
  let expect = 'user';
  const hist = [];
  for (const m of messages.slice(-14)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
    if (m.role !== expect) continue;
    hist.push({ role: m.role, content: m.content.slice(0, 2000) });
    expect = expect === 'user' ? 'assistant' : 'user';
  }

  if (hist.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Mensagem inválida.' }) };
  }

  const systemPrompt = buildSystemPrompt({ userName, habits, goals, health });

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: systemPrompt }, ...hist],
        temperature: 0.7,
        max_tokens: 1024
      })
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || ('Erro ' + r.status);
      return { statusCode: r.status === 401 ? 500 : r.status, body: JSON.stringify({ error: msg }) };
    }

    const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'Falha ao contatar a Nexa AI. Tente novamente.' }) };
  }
};
