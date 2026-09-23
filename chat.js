// netlify/functions/chat.js
// Função serverless: recebe a mensagem do app Nexa, chama a Groq usando a
// chave guardada em segredo (variável de ambiente GROQ_API_KEY) e devolve
// só o texto da resposta. A chave nunca é exposta ao navegador do usuário.

const MODEL = 'llama-3.1-8b-instant';
const FREQS = ['Todos os dias', 'Segunda a sexta', '3x por semana', '2x por semana', '1x por semana'];

function buildSystemPrompt({ userName, habits, goals }) {
  const name = (userName || 'usuário').toString().slice(0, 60);
  const habitsStr = Array.isArray(habits) && habits.length
    ? habits.slice(0, 30).map(h => String(h).slice(0, 80)).join('; ')
    : 'nenhum';
  const goalsStr = Array.isArray(goals) && goals.length
    ? goals.slice(0, 30).map(g => String(g).slice(0, 80)).join('; ')
    : 'nenhuma';

  return `Você é a Nexa AI, a mentora de hábitos, rotinas e produtividade do app Nexa. Responda em português do Brasil (ou no idioma do usuário), com tom caloroso, direto e motivador. Responda qualquer pedido do usuário, mesmo fora do tema, e ajude com o uso do app.
CRIAR HÁBITOS: quando o usuário quiser criar ou melhorar um hábito, entregue um plano prático e curto: versão mínima para começar, dias e horários sugeridos, um gatilho ("depois de X, eu faço Y"), 2 a 3 dicas para manter e como acompanhar no app. Termine confirmando com a identidade Nexa: "✅ Hábito confirmado na Nexa: <resumo em uma linha>" e, na ÚLTIMA linha da resposta, escreva a etiqueta [[HABITO|título curto|meta numérica por dia|unidade|frequência|categoria]]. Unidades: km, min, horas, vezes, copos, páginas. Frequências: ${FREQS.join(', ')} (4 ou 5 vezes = Segunda a sexta). Categorias: Saúde, Estudo, Lazer, Outros. Use a etiqueta só ao propor um hábito novo e nunca a explique.
SOBRE O APP: Início (saldo e resumo da semana), Metas (valor e progresso), Hábitos (meta diária, marcar progresso, frequência), Finanças (entradas e saídas, pessoal ou empresa; assinaturas viram saídas automaticamente no dia da cobrança), Notas (checklists com [ ], cores, fixar, busca) e Nexa AI (este chat). O botão + cria itens, o menu inferior troca de tela e o backup fica em "Minha conta" (toque na letra no topo do Início). Se não tiver certeza de algo do app, diga.
Seja concisa, use listas curtas e poucos emojis. Você não vê as finanças do usuário. Não peça senhas nem dados sensíveis.
Usuário: ${name}. Hábitos atuais: ${habitsStr}. Metas: ${goalsStr}.`;
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

  const { messages, userName, habits, goals } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Nenhuma mensagem enviada.' }) };
  }

  // Sanitiza e limita o histórico — nunca confie em dados vindos do cliente.
  const hist = messages
    .slice(-14)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));

  if (hist.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Mensagem inválida.' }) };
  }

  const systemPrompt = buildSystemPrompt({ userName, habits, goals });

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
