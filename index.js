require("dotenv").config();
const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// สำหรับ Render health check
app.get("/", (req, res) => {
  res.status(200).send("discord-webhook-reader is running");
});

// เผื่ออยากเช็กสถานะเพิ่ม
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// เปิด port ให้ Render เห็น
app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function detectProductType(text) {
  const raw = text.toLowerCase();

  if (
    raw.includes("(steam offline)") ||
    raw.includes("(epic offline)") ||
    raw.includes("(บัญชีแชร์)")
  ) {
    return "GAME_OFFLINE";
  }

  if (raw.trim()) {
    return "ONLINE_ACCOUNT";
  }

  return "OTHER";
}

function parseProductInfo(text) {
  const originalText = text.trim();
  let productName = originalText;
  let price = null;
  const productType = detectProductType(originalText);

  const priceMatch = productName.match(/\((\d+(?:\.\d+)?)\s*บาท\)/);
  if (priceMatch) {
    price = Number(priceMatch[1]);
    productName = productName
      .replace(/\s*\((\d+(?:\.\d+)?)\s*บาท\)\s*$/, "")
      .trim();
  }

  productName = productName
    .replace(/\s*\((Steam|Epic)\s+Offline\)\s*/gi, " ")
    .trim();

  if (productName.includes(" - ")) {
    productName = productName.split(" - ")[0].trim();
  }

  return {
    productName,
    price,
    productType,
  };
}

function parseBuyer(text) {
  const match = text.match(/^(.+?)\s*\(/);
  if (match) {
    return match[1].trim();
  }

  return text.trim();
}

async function sendToNextjs(payload) {
  const res = await fetch(process.env.NEXTJS_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.IMPORT_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(
      `Next.js API error: ${res.status} ${res.statusText} - ${JSON.stringify(data)}`
    );
  }

  return data;
}

client.once("ready", () => {
  console.log(`✅ บอทออนไลน์แล้ว: ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  try {
    if (
      process.env.TARGET_CHANNEL_ID &&
      message.channelId !== process.env.TARGET_CHANNEL_ID
    ) {
      return;
    }

    if (!message.webhookId) return;
    if (!message.embeds || message.embeds.length === 0) return;

    for (const embed of message.embeds) {
      if (embed.title !== "พบการซื้อสินค้า") continue;

      const fields = embed.fields ?? [];

      const productField = fields.find(
        (f) => f.name && f.name.includes("ข้อมูลสินค้า")
      );

      const buyerField = fields.find(
        (f) => f.name && f.name.includes("ผู้ซื้อ")
      );

      if (!productField || !buyerField) {
        console.log("⚠️ เจอหัวข้อซื้อสินค้า แต่ไม่พบ field ที่ต้องการ");
        continue;
      }

      const productParsed = parseProductInfo(productField.value || "");
      const buyerName = parseBuyer(buyerField.value || "");

      const result = {
        title: embed.title,
        productName: productParsed.productName,
        price: productParsed.price,
        productType: productParsed.productType,
        buyerName,
        soldAt: new Date().toISOString(),
        source: "discord-webhook",
      };

      console.log("\n==============================");
      console.log("✅ พบรายการซื้อสินค้า");
      console.log("==============================");
      console.log(result);

      const apiResult = await sendToNextjs(result);
      console.log("🚀 ส่งเข้า Next.js สำเร็จ:", apiResult);
    }
  } catch (error) {
    console.error("❌ เกิดข้อผิดพลาด:", error);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);