import { AwsClient } from "npm:aws4fetch";

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      // 1. Config ယူခြင်း
      const configData = Deno.env.get("ACCOUNTS_JSON");
      if (!configData) return new Response("Config Error: Missing ACCOUNTS_JSON", { status: 500 });
      
      const R2_ACCOUNTS = JSON.parse(configData);
      const url = new URL(request.url);
      const video = url.searchParams.get("video");
      const acc = url.searchParams.get("acc");

      // Ping check
      if (video === "ping") return new Response("Pong!", { status: 200 });

      if (!video || !acc || !R2_ACCOUNTS[acc]) {
        return new Response("Invalid Parameters", { status: 400 });
      }

      const creds = R2_ACCOUNTS[acc];
      const r2 = new AwsClient({
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        service: "s3",
        region: "auto",
      });

      const endpoint = `https://${creds.accountId}.r2.cloudflarestorage.com`;
      const bucket = creds.bucketName;
      
      // Path ရှင်းလင်းခြင်း (Space များကို %20 ပြောင်းခြင်း)
      // video param ဥပမာ: "hls/movie/master.m3u8"
      const objectPath = video; 

      // =========================================================
      // 🔥 M3U8 HANDLING (The Fix)
      // =========================================================
      if (objectPath.endsWith(".m3u8")) {
        
        // 1. Master M3U8 ကို R2 မှ လှမ်းယူရန် Link ထုတ်ခြင်း
        const m3u8Url = new URL(`${endpoint}/${bucket}/${encodeURI(objectPath)}`);
        
        const signedM3u8 = await r2.sign(m3u8Url, {
          method: "GET",
          aws: { signQuery: true },
          headers: { "Host": `${creds.accountId}.r2.cloudflarestorage.com` },
          expiresIn: 3600
        });

        // 2. M3U8 စာသားများကို ဒေါင်းလုတ်ဆွဲခြင်း
        const response = await fetch(signedM3u8.url);
        if (!response.ok) return new Response("M3U8 Not Found on R2", { status: 404 });
        
        const originalText = await response.text();
        
        // 3. Base Folder ရှာခြင်း (Relative Path ပြဿနာဖြေရှင်းရန်)
        // ဥပမာ video="hls/movie/master.m3u8" ဆိုရင် baseDir="hls/movie/"
        const lastSlashIndex = objectPath.lastIndexOf("/");
        const baseDir = lastSlashIndex !== -1 ? objectPath.substring(0, lastSlashIndex + 1) : "";

        // 4. စာကြောင်းလိုက် လိုက်ရှာပြီး .ts ဖိုင်တွေကို Sign လုပ်ခြင်း
        const lines = originalText.split("\n");
        const newLines = await Promise.all(lines.map(async (line) => {
          const trimmed = line.trim();
          
          // .ts သို့မဟုတ် .mp4 နဲ့ဆုံးတဲ့ လိုင်းဖြစ်မှ Sign လုပ်မယ်
          if (trimmed && !trimmed.startsWith("#") && (trimmed.endsWith(".ts") || trimmed.endsWith(".m4s") || trimmed.endsWith(".mp4"))) {
            
            // Full Path တည်ဆောက်ခြင်း
            // အကယ်၍ line က "segment0.ts" ဆိုရင် fullPath = "hls/movie/segment0.ts"
            // အကယ်၍ line က "http..." နဲ့စရင် (Absolute) ဒီတိုင်းထားမယ်
            
            let fullPath = trimmed;
            if (!trimmed.startsWith("http")) {
                fullPath = baseDir + trimmed;
            }

            // Segment တစ်ခုချင်းစီအတွက် Presigned URL ထုတ်ခြင်း
            const tsUrl = new URL(`${endpoint}/${bucket}/${encodeURI(fullPath)}`);
            
            const signedTs = await r2.sign(tsUrl, {
              method: "GET",
              aws: { signQuery: true },
              headers: { "Host": `${creds.accountId}.r2.cloudflarestorage.com` },
              expiresIn: 14400 // 4 Hours (Movie ကြည့်နေတုန်း မပြတ်သွားအောင်)
            });
            
            return signedTs.url; // မူရင်း line နေရာမှာ Link အရှည်ကြီး အစားထိုးမယ်
          }
          return line; // ကျန်တဲ့စာကြောင်းတွေ (EXTINF, etc.) ကို ဒီတိုင်းထားမယ်
        }));

        // 5. ပြင်ပြီးသား M3U8 စာရွက်ကို Player ဆီ ပြန်ပို့မယ်
        return new Response(newLines.join("\n"), {
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache"
          }
        });
      }

      // =========================================================
      // NORMAL MP4 HANDLING (Redirect)
      // =========================================================
      const objectUrl = new URL(`${endpoint}/${bucket}/${encodeURI(objectPath)}`);
      
      // HEAD Request (APK Size Check)
      if (request.method === "HEAD") {
        const signedHead = await r2.sign(objectUrl, {
          method: "HEAD",
          aws: { signQuery: true },
          headers: { "Host": `${creds.accountId}.r2.cloudflarestorage.com` },
          expiresIn: 3600
        });
        const r2Res = await fetch(signedHead.url, { method: "HEAD" });
        const newHeaders = new Headers(r2Res.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        return new Response(null, { status: 200, headers: newHeaders });
      }

      // GET Request Redirect
      const signedGet = await r2.sign(objectUrl, {
        method: "GET",
        aws: { signQuery: true },
        headers: { "Host": `${creds.accountId}.r2.cloudflarestorage.com` },
        expiresIn: 3600
      });

      return Response.redirect(signedGet.url, 307);

    } catch (err: any) {
      return new Response(`Error: ${err.message}`, { status: 500 });
    }
  },
};
