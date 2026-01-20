require("dotenv").config();
const puppeteer = require("puppeteer");
const axios = require("axios");
const { MongoClient } = require("mongodb");
const { URL } = require("url");

const API_BASE = "https://api.henpro.fun/api/episodes";
const VIDEO_BASE = "https://watchhentai.net/videos/";

const client = new MongoClient(process.env.MONGODB_URI);

/* -----------------------------
   Decode MP4 from iframe URL
-------------------------------- */
function decodeMp4(iframeSrc) {
  if (!iframeSrc) return null;
  try {
    const u = new URL(iframeSrc);
    const source = u.searchParams.get("source");
    return source ? decodeURIComponent(source) : null;
  } catch {
    return null;
  }
}

/* -----------------------------
   Extract iframe + download
-------------------------------- */
async function scrapeEpisode(page, videoUrl) {
  await page.goto(videoUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  // wait until iframe src is real (not about:blank)
  await page.waitForFunction(() => {
    const iframe = document.querySelector("#search_iframe");
    if (!iframe) return false;
    const src = iframe.getAttribute("src");
    return src && src !== "about:blank";
  }, { timeout: 60000 });

  return await page.evaluate(() => {
    const iframe =
      document.querySelector("#search_iframe") ||
      document.querySelector("iframe.metaframe");

    const iframeSrc =
      iframe?.getAttribute("src") ||
      iframe?.getAttribute("data-src") ||
      null;

    const downloadUrl =
      document.querySelector(".download-video")?.getAttribute("href") || null;

    return { iframeSrc, downloadUrl };
  });
}

/* -----------------------------
   MAIN
-------------------------------- */
async function run() {
  await client.connect();
  const db = client.db(process.env.MONGODB_DB);
  const collection = db.collection("episodes");

  await collection.createIndex({ episodeId: 1 }, { unique: true });

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
  );

  let currentPage = 1;
  let totalPages = 1;

  while (currentPage <= totalPages) {
    console.log(`📄 Fetching API page ${currentPage}`);

    const { data } = await axios.get(`${API_BASE}?page=${currentPage}`);
    totalPages = data.totalPages;

    for (const ep of data.data.recentEpisodes) {
      const episodeId = ep.link;
      const videoPageUrl = `${VIDEO_BASE}${episodeId}/`;

      const exists = await collection.findOne({ episodeId });
      if (exists) {
        console.log(`⏩ Skipped: ${episodeId}`);
        continue;
      }

      console.log(`🎬 Scraping: ${episodeId}`);

      try {
        const { iframeSrc, downloadUrl } =
          await scrapeEpisode(page, videoPageUrl);

        const videoUrl = decodeMp4(iframeSrc);

        await collection.insertOne({
          episodeId,
          videoPageUrl,
          iframeSrc,
          videoUrl,
          downloadUrl,
          scrapedAt: new Date(),
        });

        console.log(`✅ Saved: ${episodeId}`);
      } catch (err) {
        console.error(`❌ Failed: ${episodeId}`, err.message);
      }
    }

    currentPage++;
  }

  await browser.close();
  await client.close();

  console.log("🎉 DONE");
}

run();
