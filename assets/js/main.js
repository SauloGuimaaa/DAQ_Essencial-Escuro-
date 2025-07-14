/* ========== UTILITÁRIOS DE FORMATAÇÃO ========== */
function formatarTelefone(input) {
  const numbers = input.value.replace(/\D/g, "").substring(0, 11);
  input.value = numbers.replace(/(\d{2})(\d{5})(\d{4})/, "($1) $2‑$3");
  return numbers;
}

/* ========== MODAL (#formulario-lead) ========== */
function openModal() {
  const modal = document.getElementById("formulario-lead");
  if (!modal) return;
  modal.classList.add("active");
}

function closeModal() {
  const modal = document.getElementById("formulario-lead");
  modal?.classList.remove("active");
}

window.mostrarFormulario = openModal;
window.fecharFormulario = closeModal;
window.formatarTelefone = formatarTelefone;

/* ========== LÓGICA DE ENVIO E CHECKOUT ========== */
document.addEventListener("DOMContentLoaded", () => {
  // URLs de integração (substitua pelos seus endpoints reais)
  const BACKEND_URL = "http://localhost:3000/lead"; // Seu servidor Node.js local
  const HOTMART_CHECKOUT = "https://pay.hotmart.com/K70495535U";
  const MAKE_WEBHOOK_URL = "https://hook.us1.make.com/seu-webhook-do-make"; // Webhook do Make

  const form = document.getElementById("formNI");
  const submitBtn = form?.querySelector("button[type='submit']");

  // Feedback visual para o usuário
  const feedback = (msg, tipo = "erro") => {
    document.querySelectorAll(".form-feedback").forEach((e) => e.remove());
    const div = document.createElement("div");
    div.className = `form-feedback ${tipo}`;
    div.innerHTML =
      `<i class="fas ${tipo === "sucesso" ? "fa-check-circle" : "fa-exclamation-circle"}"></i> ${msg}`;
    form.prepend(div);
    setTimeout(() => div.remove(), 5000);
  };

  // Sanitização básica para prevenir XSS
  const sanitize = (s) =>
    s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

  // Função para enviar para o Make/Integromat
  async function enviarParaMake(dados) {
    if (!MAKE_WEBHOOK_URL) return;
    
    try {
      await fetch(MAKE_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: sanitize(dados.nome),
          email: sanitize(dados.email),
          telefone: `55${dados.whatsapp}`,
          produto: "DAQ Essencial",
          origem: "Landing Page",
          data: new Date().toISOString()
        }),
      });
    } catch (e) {
      console.error("Falha ao enviar para Make:", e);
    }
  }

  // Função principal de envio do formulário
  async function enviarFormulario(e) {
    e.preventDefault();
    if (!form || !submitBtn) return;

    // Coleta e formata os dados
    const dados = {
      nome: form.nome.value.trim(),
      email: form.email.value.trim(),
      whatsapp: formatarTelefone(form.whatsapp),
    };

    // Validações
    if (dados.nome.length < 3) return feedback("Nome incompleto (mín. 3 letras)");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dados.email)) return feedback("E‑mail inválido");
    if (dados.whatsapp.length < 11) return feedback("Telefone incompleto (DDD + número)");

    // Estado de loading
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...';

    try {
      // 1. Envia para o backend principal (Node.js)
      const resp = await fetch(BACKEND_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dados),
      }).then((r) => r.json());

      // 2. Envia para o Make em paralelo (não bloqueia o fluxo)
      enviarParaMake(dados).catch(console.error);

      // Feedback de sucesso
      feedback(resp.message || "Cadastro realizado! Redirecionando...", "sucesso");
      form.reset();
      closeModal();

      // 3. Redireciona para o checkout (mesma aba)
      const checkoutURL = new URL(HOTMART_CHECKOUT);
      checkoutURL.searchParams.append("name", dados.nome);
      checkoutURL.searchParams.append("email", dados.email);
      checkoutURL.searchParams.append("phone", `55${dados.whatsapp}`);
      window.location.href = checkoutURL.toString();

    } catch (erro) {
      console.error("Erro no envio:", erro);
      
      // Fallback: Tenta enviar pelo menos para o Make se o backend falhar
      await enviarParaMake(dados);
      
      feedback("Recebemos seus dados! Redirecionando...", "sucesso");
      closeModal();

      // Fallback para checkout sem parâmetros
      window.location.href = HOTMART_CHECKOUT;
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Quero o DAQ Essencial';
    }
  }

  // Event listener para o formulário
  form && form.addEventListener("submit", enviarFormulario);
});