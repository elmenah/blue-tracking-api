const express = require("express");
const { chromium } = require("playwright");

const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";

const BLUE_URL = "https://www.blue.cl/enviar/seguimiento";

let browser = null;
let context = null;
let page = null;
let startingBrowser = null;


// ======================================================
// NORMALIZAR ESTADOS BLUE EXPRESS
// ======================================================

function normalizeStatus(raw, eventCode) {
  const s = String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  const code = String(eventCode || "").toUpperCase();

  // Excepciones Blue
  if (["ER", "DV"].includes(code) && !s.includes("entreg")) {
    return "delivery_issue";
  }

  if (s.includes("entreg")) {
    return "delivered";
  }

  if (s.includes("reparto")) {
    return "out_for_delivery";
  }

  if (s.includes("transito")) {
    return "in_transit";
  }

  if (
    s.includes("admision") ||
    s.includes("retiro") ||
    s.includes("recibido")
  ) {
    return "carrier_received";
  }

  if (
    s.includes("preparacion") ||
    s.includes("creado")
  ) {
    return "tracking_created";
  }

  if (
    s.includes("devuelto") ||
    s.includes("devolucion")
  ) {
    return "returned";
  }

  return "unknown";
}


// ======================================================
// INICIAR CHROMIUM
// ======================================================

async function startBrowser() {

  // Si ya existe una página activa, reutilizarla
  if (page && !page.isClosed()) {
    return page;
  }

  // Evitar iniciar dos navegadores simultáneamente
  if (startingBrowser) {
    return startingBrowser;
  }

  startingBrowser = (async () => {

    if (browser) {
      try {
        await browser.close();
      } catch {}
    }

    console.log("[BLUE] Iniciando Chromium...");

    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

    context = await browser.newContext({
      locale: "es-CL"
    });

    page = await context.newPage();

    console.log("[BLUE] Abriendo Blue Express...");

    await page.goto(BLUE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    console.log("[BLUE] URL cargada:", page.url());


    // ==================================================
    // DIAGNÓSTICO CLOUDFLARE
    // ==================================================

    console.log("[BLUE] Esperando 10 segundos...");

    await page.waitForTimeout(10000);

    console.log(
      "[BLUE] URL después de 10s:",
      page.url()
    );


    // Título de la página
    let title = "";

    try {
      title = await page.title();
    } catch {}

    console.log(
      "[BLUE] Título:",
      title || "(sin título)"
    );


    // Texto visible
    let bodyText = "";

    try {
      bodyText = await page.locator("body").innerText();
    } catch {}

    console.log(
      "[BLUE] Texto página:",
      bodyText
        .substring(0, 1000)
        .replace(/\n/g, " | ")
    );


    // Cantidad de inputs
    let inputCount = 0;

    try {
      inputCount = await page.locator("input").count();
    } catch {}

    console.log(
      "[BLUE] Cantidad de inputs:",
      inputCount
    );


    // Comprobar si aparece un formulario de tracking
    let trackingInputFound = false;

    try {

      const possibleInputs = [
        "input[placeholder*='OS']",
        "input[placeholder*='seguimiento']",
        "input[name*='seguimiento']",
        "input[type='text']"
      ];

      for (const selector of possibleInputs) {

        const count = await page.locator(selector).count();

        if (count > 0) {
          trackingInputFound = true;

          console.log(
            "[BLUE] Input tracking encontrado:",
            selector
          );

          break;
        }
      }

    } catch {}


    if (!trackingInputFound) {
      console.log(
        "[BLUE] ADVERTENCIA: No se encontró formulario de tracking."
      );

      console.log(
        "[BLUE] Posible challenge/bloqueo de Cloudflare."
      );
    }


    return page;
  })();


  try {
    return await startingBrowser;
  } finally {
    startingBrowser = null;
  }
}


// ======================================================
// CONSULTAR BLUE EXPRESS
// ======================================================

async function trackBlue(os) {

  const p = await startBrowser();

  console.log(
    `[BLUE] Consultando guía ${os} desde ${p.url()}`
  );


  const result = await p.evaluate(async (os) => {

    const ua = navigator.userAgent;

    const token = btoa(
      JSON.stringify({
        nonce:
          Math.random().toString(36).slice(2, 15) +
          Math.random().toString(36).slice(2, 15),

        userAgent: ua.slice(0, 100)
      })
    );


    const response = await fetch("/api/tracking", {

      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "X-Security-Token": token
      },

      body: JSON.stringify({
        os: String(os)
      })

    });


    const responseText = await response.text();


    let json;

    try {

      json = JSON.parse(responseText);

    } catch {

      throw new Error(
        `Blue respondió HTTP ${response.status} sin JSON válido. ` +
        `Respuesta: ${responseText.substring(0, 200)}`
      );

    }


    const trace =
      json?.data?.macroState?.data?.traceMacrostates || null;


    const active =
      trace?.macrostates
        ?.filter(x => x.isActive)
        ?.map(x => x.title) || [];


    return {

      http: response.status,

      eventCode:
        trace?.lastEventCodeReal || null,

      rawStatus:
        active[0] || "",

      deliveryDate:
        json?.data?.coreOs?.data?.dateDL || null,

      lastMovement:
        json?.data?.generalInfo?.data?.lastDateMovement || null

    };

  }, os);


  return result;
}


// ======================================================
// AUTENTICACIÓN
// ======================================================

function auth(req, res, next) {

  if (!API_KEY) {

    return res.status(500).json({
      success: false,
      error: "API_KEY no configurada"
    });

  }


  if (req.headers["x-api-key"] !== API_KEY) {

    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });

  }


  next();
}


// ======================================================
// HEALTH
// ======================================================

app.get("/health", (req, res) => {

  res.json({

    success: true,

    service: "blue-tracking-api",

    browser:
      page && !page.isClosed()
        ? "running"
        : "not-started",

    current_url:
      page && !page.isClosed()
        ? page.url()
        : null

  });

});


// ======================================================
// TRACK
// ======================================================

app.get(
  "/track/:trackingNumber",
  auth,
  async (req, res) => {

    const tracking =
      String(req.params.trackingNumber || "").trim();


    if (!/^[A-Za-z0-9-]+$/.test(tracking)) {

      return res.status(400).json({

        success: false,

        error:
          "Número de seguimiento inválido"

      });

    }


    console.log(
      `[BLUE] Solicitud tracking: ${tracking}`
    );


    try {

      let r;


      // Primer intento
      try {

        r = await trackBlue(tracking);

      } catch (e) {

        console.error(
          "[BLUE] Primer intento falló:",
          e.message
        );


        // Reiniciar página y reintentar
        page = null;

        r = await trackBlue(tracking);

      }


      if (r.http !== 200) {

        return res.status(502).json({

          success: false,

          carrier: "BLUE",

          tracking_number: tracking,

          error:
            `Blue respondió HTTP ${r.http}`

        });

      }


      if (!r.rawStatus) {

        return res.status(404).json({

          success: false,

          carrier: "BLUE",

          tracking_number: tracking,

          error:
            "Blue no devolvió un estado para esta guía"

        });

      }


      const status =
        normalizeStatus(
          r.rawStatus,
          r.eventCode
        );


      console.log(
        `[BLUE] ${tracking}: ${r.rawStatus} -> ${status}`
      );


      res.json({

        success: true,

        carrier: "BLUE",

        tracking_number: tracking,

        status_raw:
          r.rawStatus,

        status,

        event_code:
          r.eventCode,

        delivered_at:
          status === "delivered"
            ? r.deliveryDate
            : null,

        last_movement:
          r.lastMovement || null,

        checked_at:
          new Date().toISOString()

      });


    } catch (e) {

      console.error(
        `[BLUE] Error ${tracking}:`,
        e.message
      );


      res.status(500).json({

        success: false,

        carrier: "BLUE",

        tracking_number: tracking,

        error:
          e.message

      });

    }

  }
);


// ======================================================
// START
// ======================================================

app.listen(
  PORT,
  "0.0.0.0",
  async () => {

    console.log(
      `[BLUE] API puerto ${PORT}`
    );


    try {

      await startBrowser();

    } catch (e) {

      console.error(
        "[BLUE] Chromium:",
        e.message
      );

    }

  }
);


// ======================================================
// SHUTDOWN
// ======================================================

async function shutdown() {

  console.log(
    "[BLUE] Cerrando servicio..."
  );


  try {

    if (browser) {
      await browser.close();
    }

  } catch {}


  process.exit(0);
}


process.on(
  "SIGTERM",
  shutdown
);

process.on(
  "SIGINT",
  shutdown
);
