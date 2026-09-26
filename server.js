const express = require("express");
const { chromium } = require("playwright");
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const BLUE_URL = "https://www.blue.cl/enviar/seguimiento";
let browser=null, context=null, page=null, startingBrowser=null;

function normalizeStatus(raw,eventCode){
  const s=String(raw||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
  if(["ER","DV"].includes(String(eventCode||"").toUpperCase()) && !s.includes("entreg")) return "delivery_issue";
  if(s.includes("entreg")) return "delivered";
  if(s.includes("reparto")) return "out_for_delivery";
  if(s.includes("transito")) return "in_transit";
  if(s.includes("admision")||s.includes("retiro")||s.includes("recibido")) return "carrier_received";
  if(s.includes("preparacion")||s.includes("creado")) return "tracking_created";
  if(s.includes("devuelto")||s.includes("devolucion")) return "returned";
  return "unknown";
}

async function startBrowser(){
  if(page && !page.isClosed()) return page;
  if(startingBrowser) return startingBrowser;

  startingBrowser=(async()=>{
    if(browser){
      try{await browser.close()}catch{}
    }

    browser=await chromium.launch({
      headless:true,
      args:[
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

    context=await browser.newContext({
      locale:"es-CL"
    });

    page=await context.newPage();

    console.log("[BLUE] Abriendo Blue Express...");

    await page.goto(BLUE_URL,{
      waitUntil:"domcontentloaded",
      timeout:60000
    });

    console.log("[BLUE] URL cargada:", page.url());

    // Esperar a que realmente cargue la aplicación de seguimiento.
    // Esto reemplaza la espera fija de 5 segundos.
    await page.waitForSelector(
      "input[placeholder*='OS']",
      {
        state:"visible",
        timeout:40000
      }
    );

    console.log("[BLUE] Página de seguimiento lista:", page.url());

    return page;
  })();

  try{
    return await startingBrowser;
  }finally{
    startingBrowser=null;
  }
}

async function trackBlue(os){
  const p=await startBrowser();
  return await p.evaluate(async(os)=>{
    const ua=navigator.userAgent;
    const token=btoa(JSON.stringify({
      nonce:Math.random().toString(36).slice(2,15)+Math.random().toString(36).slice(2,15),
      userAgent:ua.slice(0,100)
    }));
    const response=await fetch("/api/tracking",{
      method:"POST",
      headers:{"Content-Type":"application/json","X-Security-Token":token},
      body:JSON.stringify({os:String(os)})
    });
    let json;
    try{json=await response.json()}catch{throw new Error(`Blue respondió HTTP ${response.status} sin JSON válido`)}
    const trace=json?.data?.macroState?.data?.traceMacrostates||null;
    const active=trace?.macrostates?.filter(x=>x.isActive)?.map(x=>x.title)||[];
    return {
      http:response.status,
      eventCode:trace?.lastEventCodeReal||null,
      rawStatus:active[0]||"",
      deliveryDate:json?.data?.coreOs?.data?.dateDL||null,
      lastMovement:json?.data?.generalInfo?.data?.lastDateMovement||null
    };
  },os);
}

function auth(req,res,next){
  if(!API_KEY) return res.status(500).json({success:false,error:"API_KEY no configurada"});
  if(req.headers["x-api-key"]!==API_KEY) return res.status(401).json({success:false,error:"Unauthorized"});
  next();
}

app.get("/health",(req,res)=>res.json({
  success:true,service:"blue-tracking-api",
  browser:page&&!page.isClosed()?"running":"not-started"
}));

app.get("/track/:trackingNumber",auth,async(req,res)=>{
  const tracking=String(req.params.trackingNumber||"").trim();
  if(!/^[A-Za-z0-9-]+$/.test(tracking)) return res.status(400).json({success:false,error:"Número de seguimiento inválido"});
  try{
    let r;
    try{r=await trackBlue(tracking)}
    catch(e){page=null;r=await trackBlue(tracking)}
    if(r.http!==200) return res.status(502).json({success:false,carrier:"BLUE",tracking_number:tracking,error:`Blue respondió HTTP ${r.http}`});
    if(!r.rawStatus) return res.status(404).json({success:false,carrier:"BLUE",tracking_number:tracking,error:"Blue no devolvió un estado para esta guía"});
    const status=normalizeStatus(r.rawStatus,r.eventCode);
    res.json({
      success:true,carrier:"BLUE",tracking_number:tracking,
      status_raw:r.rawStatus,status,event_code:r.eventCode,
      delivered_at:status==="delivered"?r.deliveryDate:null,
      last_movement:r.lastMovement||null,checked_at:new Date().toISOString()
    });
  }catch(e){
    res.status(500).json({success:false,carrier:"BLUE",tracking_number:tracking,error:e.message});
  }
});

app.listen(PORT,"0.0.0.0",async()=>{
  console.log(`[BLUE] API puerto ${PORT}`);
  try{await startBrowser()}catch(e){console.error("[BLUE] Chromium:",e.message)}
});

async function shutdown(){try{if(browser)await browser.close()}catch{} process.exit(0)}
process.on("SIGTERM",shutdown); process.on("SIGINT",shutdown);
