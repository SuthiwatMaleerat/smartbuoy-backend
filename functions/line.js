const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const axios = require("axios");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp();
const db = getFirestore();

// ✅ Trigger เมื่อ alerts ถูกสร้างใหม่
exports.alertToLine = onDocumentCreated(
  {
    document: "alerts/{alertId}",
    region: "asia-southeast1",
  },
  async (event) => {
    console.log("🔥 alertToLine triggered");

    const snap = event.data;
    const alert = snap.data();
    if (!alert?.buoy_id) {
      console.log("⚠️ No buoy_id found in alert");
      return;
    }

    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!token) {
      console.error("❌ Missing LINE_CHANNEL_ACCESS_TOKEN");
      return;
    }

    const linkedUsers = await db.collection("line_links")
      .where("buoy_id", "==", alert.buoy_id)
      .get();

    if (linkedUsers.empty) {
      console.log("⚠️ NO User linked to this buoy");
      return;
    }

    const message =
      `⚠️ แจ้งเตือนคุณภาพน้ำ\n` +
      `ทุ่น: ${alert.buoy_id}\n` +
      `${alert.message || "ไม่มีข้อความ"}\n` +
      `ค่าที่วัดได้: ${alert.value || "-"}`;

    const sendTasks = linkedUsers.docs.map(doc => {
      const { lineUserId } = doc.data();
      return axios.post(
        "https://api.line.me/v2/bot/message/push",
        {
          to: lineUserId,
          messages: [{ type: "text", text: message }],
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        }
      );
    });

    await Promise.all(sendTasks);
    console.log("✅ LINE messages sent!");
  }
);

// ✅ Webhook ใช้ผูก LINE กับ buoy
exports.lineWebhook = onRequest(
  { region: "asia-southeast1" },
  async (req, res) => {
    const event = req.body.events?.[0];
    if (!event) return res.status(200).send("No event");

    const lineUserId = event.source.userId;
    const text = event.message?.text?.trim();

    if (text && text.toLowerCase().startsWith("link ")) {
      const buoy_id = text.split(" ")[1];

      await db.collection("line_links").doc(lineUserId).set({
        lineUserId,
        buoy_id,
        at: new Date().toISOString(),
      });

      await pushMessage(lineUserId, `✅ ผูกกับทุ่น ${buoy_id} เรียบร้อย`);
    } else {
      await pushMessage(lineUserId, "พิมพ์: link buoy_001");
    }

    return res.status(200).send("OK");
  }
);

async function pushMessage(to, text) {
  return axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to,
      messages: [{ type: "text", text }],
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );
}
