require('dotenv').config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const morgan = require('morgan');

// Configuração inicial
const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'leads.db');

// Middlewares
app.use(cors());
app.use(express.json());
app.use(morgan('dev')); // Logs das requisições

// Verifica e cria diretório de dados
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}

// Conexão com o banco SQLite
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Erro ao conectar ao SQLite:', err.message);
    process.exit(1);
  }
  console.log(`Conectado ao SQLite em ${DB_PATH}`);
  initializeDatabase();
});

// Inicialização do banco de dados
function initializeDatabase() {
  db.run(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT,
      whatsapp TEXT NOT NULL UNIQUE,
      data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      enviado_ni BOOLEAN DEFAULT 0,
      enviado_make BOOLEAN DEFAULT 0,
      erro_ni TEXT,
      erro_make TEXT,
      checkout_url TEXT
    )
  `, (err) => {
    if (err) console.error("Erro ao criar tabela leads:", err);
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      endpoint TEXT,
      metodo TEXT,
      status INTEGER,
      mensagem TEXT
    )
  `, (err) => {
    if (err) console.error("Erro ao criar tabela logs:", err);
  });
}

// Função para log de atividades
async function logActivity(endpoint, metodo, status, mensagem) {
  db.run(
    "INSERT INTO logs (endpoint, metodo, status, mensagem) VALUES (?, ?, ?, ?)",
    [endpoint, metodo, status, mensagem],
    (err) => {
      if (err) console.error("Erro ao registrar log:", err);
    }
  );
}

// Validação de variáveis de ambiente
const requiredEnvVars = ['NI_TOKEN', 'NI_API_URL', 'MAKE_WEBHOOK_URL'];
requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`ERRO: Variável de ambiente ${varName} não configurada`);
    process.exit(1);
  }
});

// Rotas de API
app.post('/api/lead', async (req, res) => {
  const { nome, email, whatsapp } = req.body;

  // Validação básica
  if (!nome || !whatsapp) {
    await logActivity('/api/lead', 'POST', 400, 'Dados incompletos');
    return res.status(400).json({ 
      success: false, 
      message: 'Nome e WhatsApp são obrigatórios' 
    });
  }

  try {
    // 1. Salva no banco local
    const leadId = await saveLeadLocal({ nome, email, whatsapp });
    
    // 2. Envia para serviços externos em paralelo
    const [niResult, makeResult] = await Promise.allSettled([
      sendToNotificationsInteligentes({ nome, email, whatsapp }),
      sendToMakeAutomation({ nome, email, whatsapp })
    ]);

    // 3. Prepara URL de checkout com parâmetros UTM
    const checkoutUrl = generateCheckoutUrl({ nome, email, whatsapp });

    // 4. Atualiza lead com URL de checkout
    await updateLeadWithCheckout(whatsapp, checkoutUrl);

    await logActivity('/api/lead', 'POST', 200, `Lead ${leadId} processado`);
    
    res.json({
      success: true,
      message: 'Lead cadastrado com sucesso!',
      checkout_url: checkoutUrl
    });

  } catch (error) {
    console.error('Erro no processamento:', error);
    await logActivity('/api/lead', 'POST', 500, `Erro: ${error.message}`);
    
    res.status(500).json({
      success: false,
      message: 'Ocorreu um erro ao processar seu cadastro'
    });
  }
});

// Funções auxiliares
async function saveLeadLocal({ nome, email, whatsapp }) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO leads (nome, email, whatsapp) VALUES (?, ?, ?)
       ON CONFLICT(whatsapp) DO UPDATE SET
         nome = excluded.nome,
         email = excluded.email`,
      [nome, email, whatsapp],
      function(err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

async function sendToNotificationsInteligentes({ nome, email, whatsapp }) {
  try {
    const response = await axios.post(
      `${process.env.NI_API_URL}/leads`,
      {
        name: nome,
        phone: `55${whatsapp}`,
        email: email || '',
        custom_fields: {
          origem: "Landing Page DAQ",
          produto: "DAQ Essencial"
        },
        tags: ["landing-page", "daq-essencial"]
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.NI_TOKEN}`,
          "Content-Type": "application/json"
        },
        timeout: 10000
      }
    );

    await db.run(
      "UPDATE leads SET enviado_ni = 1 WHERE whatsapp = ?",
      [whatsapp]
    );

    return response.data;
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    await db.run(
      "UPDATE leads SET erro_ni = ? WHERE whatsapp = ?",
      [errorMsg.substring(0, 200), whatsapp]
    );
    throw error;
  }
}

async function sendToMakeAutomation({ nome, email, whatsapp }) {
  try {
    const response = await axios.post(
      process.env.MAKE_WEBHOOK_URL,
      {
        nome,
        email,
        telefone: `55${whatsapp}`,
        produto: "DAQ Essencial",
        origem: "Landing Page",
        data_cadastro: new Date().toISOString()
      },
      { timeout: 10000 }
    );

    await db.run(
      "UPDATE leads SET enviado_make = 1 WHERE whatsapp = ?",
      [whatsapp]
    );

    return response.data;
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    await db.run(
      "UPDATE leads SET erro_make = ? WHERE whatsapp = ?",
      [errorMsg.substring(0, 200), whatsapp]
    );
    throw error;
  }
}

function generateCheckoutUrl({ nome, email, whatsapp }) {
  const baseUrl = "https://pay.hotmart.com/K70495535U";
  const url = new URL(baseUrl);
  
  url.searchParams.append("name", nome);
  url.searchParams.append("email", email || '');
  url.searchParams.append("phone", `55${whatsapp}`);
  url.searchParams.append("utm_source", "landing_page");
  url.searchParams.append("utm_medium", "form");
  url.searchParams.append("utm_campaign", "daq_essencial");

  return url.toString();
}

async function updateLeadWithCheckout(whatsapp, checkoutUrl) {
  return new Promise((resolve, reject) => {
    db.run(
      "UPDATE leads SET checkout_url = ? WHERE whatsapp = ?",
      [checkoutUrl, whatsapp],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Rota para listagem de leads (para administração)
app.get('/api/leads', (req, res) => {
  db.all(
    "SELECT id, nome, email, whatsapp, data_cadastro FROM leads ORDER BY data_cadastro DESC",
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Erro ao buscar leads" });
      }
      res.json(rows);
    }
  );
});

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    database: 'SQLite',
    services: {
      notifications_inteligentes: !!process.env.NI_TOKEN,
      make_automation: !!process.env.MAKE_WEBHOOK_URL
    },
    timestamp: new Date().toISOString()
  });
});

// Inicia o servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Modo: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Banco de dados: ${DB_PATH}`);
});

// Tratamento de erros globais
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// Nova rota para integração com a automação
app.post('/api/integracao-automacao', async (req, res) => {
    const { nome, telefone } = req.body;

    if (!nome || !telefone) {
        await logActivity('/api/integracao-automacao', 'POST', 400, 'Dados incompletos');
        return res.status(400).json({ 
            success: false, 
            message: 'Nome e telefone são obrigatórios' 
        });
    }

    try {
        // Envia para o sistema de automação
        const response = await axios.post(
            'http://localhost:5000/enviar_mensagem',
            { nome, telefone },
            { timeout: 10000 }
        );

        await logActivity('/api/integracao-automacao', 'POST', 200, `Mensagem para ${telefone} enfileirada`);
        
        res.json({
            success: true,
            message: 'Mensagem enfileirada com sucesso'
        });

    } catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        await logActivity('/api/integracao-automacao', 'POST', 500, `Erro: ${errorMsg}`);
        
        res.status(500).json({
            success: false,
            message: 'Erro ao enfileirar mensagem'
        });
    }
});