const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Parser = require('rss-parser');
const cheerio = require('cheerio');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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
    { url: 'https://www.jornalopcao.com.br/feed/', region: 'go', sourceName: 'Jornal Opção' }
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
            if (link && !link.startsWith('http')) link = 'https://www.correiobraziliense.com.br' + link;
            if (title && link) {
                articles.push({
                    title, link, description: 'Leia a matéria completa no site do Correio Braziliense.',
                    pubDate: new Date().toISOString(), source: 'Correio Braziliense', region: 'df', image: image || null
                });
            }
        });
        return articles;
    } catch (error) { return []; }
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
    const imgMatch = (item.contentEncoded || item.content || item.description || '').match(/<img[^>]+src="([^">]+)"/);
    if (imgMatch && imgMatch[1]) return imgMatch[1];
    return null;
}

async function fetchRealImageFromUrl(url) {
    try {
        const res = await axios.get(url, { timeout: 3000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(res.data);
        return $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || null;
    } catch (e) { return null; }
}

// Bando de Dados em Memória (Failsafe para Render)
let MEMORY_DB_NEWS = [];
let MEMORY_DB_SUMMARIES = {};
let isFetching = false;
const imageCache = new Map();

async function refreshNewsCache() {
    if (isFetching) return;
    isFetching = true;
    try {
        console.log("Buscando feeds XML...");
        const feedPromises = FEEDS.map(async (feed) => {
            try {
                const response = await axios.get(feed.url, { timeout: 4000, headers: { 'User-Agent': 'Mozilla/5.0' } });
                const parsedFeed = await parser.parseString(response.data);
                return parsedFeed.items.slice(0, 6).map(item => {
                    let cleanDesc = (item.description || '').replace(/<[^>]*>?/gm, '').trim();
                    if (cleanDesc.length > 150) cleanDesc = cleanDesc.substring(0, 150) + '...';
                    return {
                        title: emphasizeTitle(item.title), link: item.link, description: cleanDesc,
                        pubDate: new Date(item.pubDate || item.isoDate).toISOString(),
                        source: feed.sourceName, region: feed.region, image: extractImageFromRSSItem(item)
                    };
                });
            } catch (err) { return []; }
        });

        feedPromises.push(fetchCorreioBraziliense().then(items => items.map(i => ({...i, title: emphasizeTitle(i.title)}))));

        const results = await Promise.all(feedPromises);
        MEMORY_DB_NEWS = results.flat().sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate)).slice(0, 50);
        
        console.log("Feeds carregados em memória. Iniciando busca de capas...");
        isFetching = false;

        // Raspagem de capas muito segura (uma por uma)
        setTimeout(async () => {
            for (let news of MEMORY_DB_NEWS) {
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
            console.log("Capas atualizadas em memória.");
        }, 1000);
        
    } catch (error) {
        isFetching = false;
    }
}

// Inicializa a primeira busca imediatamente
refreshNewsCache();
setInterval(refreshNewsCache, 5 * 60 * 1000);

app.get('/api/news', async (req, res) => {
    // Se o cache em memória já tiver dados (mesmo sem imagem), envia imediatamente
    if (MEMORY_DB_NEWS.length > 0) {
        return res.json({ status: 'ok', items: MEMORY_DB_NEWS });
    }
    // Se não tiver nada, força uma busca rápida de 3 segundos e retorna
    await refreshNewsCache();
    return res.json({ status: 'ok', items: MEMORY_DB_NEWS });
});

app.get('/api/summarize', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Faltou o parâmetro url' });

    try {
        if (MEMORY_DB_SUMMARIES[targetUrl]) {
            return res.json({ summary: MEMORY_DB_SUMMARIES[targetUrl], cached: true });
        }

        const response = await axios.get(targetUrl, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const dom = new JSDOM(response.data, { url: targetUrl });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (!article || !article.textContent) return res.status(500).json({ error: 'Falha ao ler o texto.' });

        const articleText = article.textContent.trim();
        let summaryResult = '';

        if (ai) {
            const prompt = `Resuma os fatos principais desta notícia em tópicos curtos HTML (<ul><li>). Não use parágrafos. Texto: ${articleText}`;
            const aiResponse = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
            summaryResult = aiResponse.text.replace(/```html|```/g, '').trim();
        } else {
            summaryResult = `<ul><li>A IA não está configurada.</li></ul>`;
        }

        MEMORY_DB_SUMMARIES[targetUrl] = summaryResult;
        res.json({ summary: summaryResult, cached: false });

    } catch (error) {
        res.status(500).json({ error: 'Erro ao resumir.' });
    }
});

app.get('/', (req, res) => res.send('Giro Metropolitano Backend OK - V3 (Memória Pura)'));

app.listen(PORT, () => {
    console.log(`Servidor ultra-leve rodando na porta ${PORT}`);
});
