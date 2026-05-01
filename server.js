const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Parser = require('rss-parser');
const cheerio = require('cheerio');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Inicia Banco de Dados
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error('Erro ao conectar ao SQLite:', err.message);
    } else {
        console.log('Conectado ao banco de dados SQLite.');
        db.run(`CREATE TABLE IF NOT EXISTS summaries (
            url TEXT PRIMARY KEY,
            summary TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS feed_cache (
            id INTEGER PRIMARY KEY,
            data TEXT
        )`);
    }
});

const parser = new Parser({
    customFields: {
        item: [
            ['media:content', 'mediaContent', {keepArray: false}],
            ['content:encoded', 'contentEncoded']
        ]
    }
});

let ai = null;
try {
    const { GoogleGenAI } = require('@google/genai');
    if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'sua_chave_api_aqui') {
        ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        console.log("Integração com Gemini AI inicializada com sucesso.");
    }
} catch (e) {
    console.error("Erro ao importar @google/genai");
}

const FEEDS = [
    { url: 'https://g1.globo.com/rss/g1/df/distrito-federal/', region: 'df', sourceName: 'G1 DF' },
    { url: 'https://g1.globo.com/rss/g1/goias/', region: 'go', sourceName: 'G1 Goiás' },
    { url: 'https://www.metropoles.com/distrito-federal/feed', region: 'df', sourceName: 'Metrópoles' },
    { url: 'https://www.metropoles.com/colunas/feed', region: 'df', sourceName: 'Metrópoles Colunas' },
    { url: 'https://maisgoias.com.br/feed', region: 'go', sourceName: 'Mais Goiás' },
    { url: 'https://diariodoentorno.com.br/feed', region: 'df', sourceName: 'Diário do Entorno' },
    { url: 'https://jornalaguaslindas.com.br/feed/', region: 'df', sourceName: 'Jornal Águas Lindas' },
    { url: 'https://folhadeaguaslindas.com.br/feed/', region: 'df', sourceName: 'Folha de Águas Lindas' },
    { url: 'https://vozdoentornogo.com.br/feed/', region: 'df', sourceName: 'Voz do Entorno GO' },
    { url: 'https://jornaldebrasilia.com.br/feed/', region: 'df', sourceName: 'Jornal de Brasília' },
    { url: 'https://portal6.com.br/feed/', region: 'go', sourceName: 'Portal 6' },
    { url: 'https://www.jornalopcao.com.br/feed/', region: 'go', sourceName: 'Jornal Opção' },
    { url: 'https://news.google.com/rss/search?q=%22%C3%81guas+Lindas+de+Goi%C3%A1s%22&hl=pt-BR&gl=BR&ceid=BR:pt-419', region: 'go', sourceName: 'Busca Tempo Real: Águas Lindas' },
    { url: 'https://news.google.com/rss/search?q=%22bastidores+da+pol%C3%ADtica%22+DF+OR+Goi%C3%A1s&hl=pt-BR&gl=BR&ceid=BR:pt-419', region: 'df', sourceName: 'Busca: Bastidores Política' },
    { url: 'https://news.google.com/rss/search?q=fofoca+famosos+bras%C3%ADlia+goi%C3%A2nia&hl=pt-BR&gl=BR&ceid=BR:pt-419', region: 'todos', sourceName: 'Busca: Fofoca Social' }
];

async function fetchCorreioBraziliense() {
    try {
        const response = await axios.get('https://www.correiobraziliense.com.br/cidades-df/', {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 5000
        });
        const $ = cheerio.load(response.data);
        const articles = [];
        
        $('article').slice(0, 5).each((i, el) => {
            const title = $(el).find('h2, h3').text().trim() || $(el).find('a[title]').attr('title');
            let link = $(el).find('a').attr('href');
            let image = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || '';
            
            if (link && !link.startsWith('http')) {
                link = 'https://www.correiobraziliense.com.br' + link;
            }
            
            if (title && link) {
                articles.push({
                    title,
                    link,
                    description: 'Leia a matéria completa no site do Correio Braziliense.',
                    pubDate: new Date().toISOString(),
                    source: 'Correio Braziliense',
                    region: 'df',
                    image: image || null
                });
            }
        });
        return articles;
    } catch (error) {
        return [];
    }
}

function emphasizeTitle(title) {
    const lowerTitle = title.toLowerCase();
    let newTitle = title;
    if (lowerTitle.match(/política|câmara|senado|deputado|governador|prefeito|stf|eleições|bastidores|partido|ministro/)) {
        newTitle = `🏛️ ${newTitle}`;
    } else if (lowerTitle.match(/fofoca|famoso|celebridade|namoro|separação|traição|reality|ator|cantor/)) {
        newTitle = `🔥 ${newTitle}`;
    }
    return newTitle;
}

function extractImageFromRSSItem(item) {
    if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) return item.mediaContent.$.url;
    if (item.enclosure && item.enclosure.url) return item.enclosure.url;
    const htmlContent = item.contentEncoded || item.content || item.description || '';
    const imgMatch = htmlContent.match(/<img[^>]+src="([^">]+)"/);
    if (imgMatch && imgMatch[1]) return imgMatch[1];
    return null;
}

async function fetchRealImageFromUrl(url) {
    try {
        const res = await axios.get(url, {
            timeout: 3000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const $ = cheerio.load(res.data);
        return $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || null;
    } catch (e) {
        return null;
    }
}

let cachedNews = [];
let isFetching = false;
const imageCache = new Map();

async function refreshNewsCache() {
    if (isFetching) return;
    isFetching = true;
    try {
        console.log("Atualizando cache de notícias em background...");
        const feedPromises = FEEDS.map(async (feed) => {
            try {
                const parsedFeed = await parser.parseURL(feed.url);
                return parsedFeed.items.slice(0, 6).map(item => {
                    let cleanDesc = (item.description || '').replace(/<[^>]*>?/gm, '').trim();
                    if (cleanDesc.length > 150) cleanDesc = cleanDesc.substring(0, 150) + '...';
                    
                    return {
                        title: emphasizeTitle(item.title),
                        link: item.link,
                        description: cleanDesc,
                        pubDate: new Date(item.pubDate || item.isoDate).toISOString(),
                        source: feed.sourceName,
                        region: feed.region,
                        image: extractImageFromRSSItem(item)
                    };
                });
            } catch (err) {
                return [];
            }
        });

        feedPromises.push(fetchCorreioBraziliense().then(items => items.map(i => ({...i, title: emphasizeTitle(i.title)}))));

        const results = await Promise.all(feedPromises);
        cachedNews = results.flat().sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate)).slice(0, 50);
        
        // Salva imediatamente a versão apenas em texto para destravar a tela
        db.run("INSERT OR REPLACE INTO feed_cache (id, data) VALUES (1, ?)", [JSON.stringify(cachedNews)]);
        console.log("Feeds básicos carregados. Iniciando raspagem de imagens em segundo plano...");
        isFetching = false; // Libera logo a requisição
        
        // Raspa imagens devagar nos bastidores
        setTimeout(async () => {
            for (let news of cachedNews) {
                if (!news.image) {
                    if (imageCache.has(news.link)) {
                        news.image = imageCache.get(news.link);
                    } else {
                        const realImg = await fetchRealImageFromUrl(news.link);
                        news.image = realImg || 'https://images.unsplash.com/photo-1495020689067-958852a7765e?q=80&w=600&auto=format&fit=crop';
                        if (realImg) imageCache.set(news.link, realImg);
                    }
                }
            }
            db.run("INSERT OR REPLACE INTO feed_cache (id, data) VALUES (1, ?)", [JSON.stringify(cachedNews)]);
            console.log("Todas as imagens foram baixadas e salvas no banco.");
        }, 100);
        
    } catch (error) {
        console.error("Erro ao atualizar cache:", error.message);
        isFetching = false;
    }
}

// Carrega dados do banco de dados na inicialização
db.get("SELECT data FROM feed_cache WHERE id = 1", (err, row) => {
    if (row && row.data) {
        cachedNews = JSON.parse(row.data);
        console.log("Notícias carregadas do SQLite quase instantaneamente.");
    }
    // Dispara a busca atualizada
    refreshNewsCache();
});

// Atualiza o cache a cada 5 minutos
setInterval(refreshNewsCache, 5 * 60 * 1000);

app.get('/api/news', async (req, res) => {
    if (cachedNews.length > 0) {
        return res.json({ status: 'ok', items: cachedNews });
    } else {
        // Se ainda não carregou do SQLite nem da internet, espera carregar a primeira vez
        await refreshNewsCache();
        return res.json({ status: 'ok', items: cachedNews });
    }
});

const getCachedSummary = (url) => new Promise((resolve, reject) => {
    db.get("SELECT summary FROM summaries WHERE url = ?", [url], (err, row) => {
        if (err) reject(err);
        resolve(row ? row.summary : null);
    });
});

app.get('/api/summarize', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Faltou o parâmetro url' });

    try {
        const cachedSummary = await getCachedSummary(targetUrl);
        if (cachedSummary) {
            return res.json({ summary: cachedSummary, cached: true });
        }

        const response = await axios.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const dom = new JSDOM(response.data, { url: targetUrl });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (!article || !article.textContent) {
            return res.status(500).json({ error: 'Não foi possível extrair o texto.' });
        }

        const articleText = article.textContent.trim();
        let summaryResult = '';

        if (ai) {
            const prompt = `Você é um assistente jornalista focado em produtividade. Resuma a seguinte reportagem focando nos pontos cruciais e fatos principais.
Sua resposta OBRIGATORIAMENTE deve ser formatada em HTML usando as tags <ul> e <li>. Não escreva "Aqui está o resumo", nem use parágrafos <p>, retorne EXCLUSIVAMENTE uma lista de tópicos curtos (bullet points) com os fatos da matéria.
Reportagem:
${articleText}`;
            
            const aiResponse = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
            });
            summaryResult = aiResponse.text;
            summaryResult = summaryResult.replace(/```html|```/g, '').trim();
        } else {
            summaryResult = `<ul><li>A IA não está configurada (Falta GEMINI_API_KEY).</li><li>Texto bruto extraído: ${articleText.substring(0, 200)}...</li></ul>`;
        }

        db.run("INSERT OR REPLACE INTO summaries (url, summary) VALUES (?, ?)", [targetUrl, summaryResult]);
        res.json({ summary: summaryResult, cached: false });

    } catch (error) {
        console.error('Erro /summarize:', error.message);
        res.status(500).json({ error: 'Erro ao tentar ler e resumir.' });
    }
});

app.listen(PORT, () => {
    console.log(`Backend rodando na porta ${PORT} com caching ultra-rápido via SQLite.`);
});
