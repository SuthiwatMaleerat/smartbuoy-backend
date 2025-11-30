// functions/auth.js
// ===== Auth endpoints: register / login / reset =====
// - ผูก region = asia-southeast1 ให้ชัด
// - ใช้ global fetch (ไม่ต้องใช้ node-fetch)

const { onRequest } = require("firebase-functions/v2/https");
const { getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

// ใช้ค่า apiKey ของโปรเจกต์จริง (ของมูน)
const FIREBASE_API_KEY = "AIzaSyDWXrgjVJIyUKz2DGpKjd4vdIU7SdwJHMs";

// init admin (idempotent)
if (!getApps().length) initializeApp();
const db = getFirestore();

// ---------- Register ----------
exports.registerUser = onRequest({ region: "asia-southeast1", cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const { email, password, name, surname, phone } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Missing email or password" });

    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      }
    );
    const data = await resp.json();
    if (!resp.ok) return res.status(400).json({ error: data?.error?.message || "signUp_failed" });

    // บันทึกโปรไฟล์เบื้องต้นใน Firestore
    await db.collection("users").doc(data.localId).set({
      uid: data.localId,
      email: data.email,
      name: name || "",
      surname: surname || "",
      phone: phone || "",
      role: "user",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { merge: true });

    return res.json({ success: true, uid: data.localId, email: data.email });
  } catch (e) {
    console.error("registerUser error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
});

// ---------- Login ----------
exports.loginUser = onRequest({ region: "asia-southeast1", cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Missing email or password" });

    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      }
    );
    const data = await resp.json();
    if (!resp.ok) return res.status(400).json({ error: data?.error?.message || "login_failed" });

    return res.json({
      success: true,
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      uid: data.localId,
      email: data.email,
    });
  } catch (e) {
    console.error("loginUser error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
});

// ---------- Reset Password ----------
exports.resetPassword = onRequest({ region: "asia-southeast1", cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: "Missing email" });

    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestType: "PASSWORD_RESET", email }),
      }
    );
    const data = await resp.json();
    if (!resp.ok) return res.status(400).json({ error: data?.error?.message || "reset_failed" });

    return res.json({ success: true, message: "Password reset email sent" });
  } catch (e) {
    console.error("resetPassword error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
});
