import { AwsClient } from "npm:aws4fetch";

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      // 1. Config ယူခြင်း
      const configData = Deno.env.get("ACCOUNTS_JSON");
      if (!configData) return new Response("Config Error", { status: 500 });
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

      // 2. M3U8 ဖိုင် ဟုတ်မဟုတ် စစ်ဆေးခြင်း
      if (video.endsWith(".m3u8")) {
        
        // M3U8 ဖိုင်ကို R2 မှ လှမ်းယူရန် Link ထုတ်ခြင်း
        const m3u8Url = new URL(`${endpoint}/${bucket}/${video}`);
        const signedM3u8 = await r2.sign(m3u8Url, {
          method: "GET",
          aws: { signQuery: true },
          headers: { "Host": `${creds.accountId}.r2.cloudflarestorage.com` },
          expiresIn: 3600
        });

        // M3U8 စာသားများကို ဒေါင်းလုတ်ဆွဲခြင်း
        const response = await fetch(signedM3u8.url);
        if (!response.ok) return new Response("M3U8 Not Found on R2", { status: 404 });
        
        const originalText = await response.text();
        
        // 🔥 MAGIC STEP: လိုင်းတိုင်းကို လိုက်စစ်ပြီး .ts တွေ့ရင် Sign လုပ်မယ်
        const folderPath = video.substring(0, video.lastIndexOf("/")); // ts ဖိုင်တွေရှိတဲ့ folder
        
        // စာကြောင်းလိုက် ခွဲမယ်
        const lines = originalText.split("\n");
        const newLines = await Promise.all(lines.map(async (line) => {
          const trimmed = line.trim();
          
          // .ts သို့မဟုတ် .mp4 နဲ့ဆုံးတဲ့ လိုင်းဖြစ်မှ Sign လုပ်မယ်
          if (trimmed && !trimmed.startsWith("#") && (trimmed.endsWith(".ts") || trimmed.endsWith(".mp4"))) {
            
            // Full Path တည်ဆောက်ခြင်း
            // ဥပမာ: video.m3u8 က "hls/movie/" အောက်မှာရှိရင် ts က "hls/movie/segment0.ts" ဖြစ်မယ်
            const fullPath = trimmed.startsWith("http") ? trimmed : `${folderPath}/${trimmed}`;
            
            // Segment တစ်ခုချင်းစီအတွက် Presigned URL ထုတ်ခြင်း
            const tsUrl = new URL(`${endpoint}/${bucket}/${fullPath}`);
            const signedTs = await r2.sign(tsUrl, {
              method: "GET",
              aws: { signQuery: true },
              headers: { "Host": `${creds.accountId}.r2.cloudflarestorage.com` },
              expiresIn: 14400 // 4 Hours Expire
            });
            
            return signedTs.url; // Link အသစ်နဲ့ အစားထိုးမယ်
          }
          return line; // ကျန်တဲ့စာကြောင်းတွေ (EXTINF, etc.) ကို ဒီတိုင်းထားမယ်
        }));

        // ပြင်ပြီးသား စာရွက်ကို Player ဆီ ပြန်ပို့မယ်
        return new Response(newLines.join("\n"), {
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }

      // 3. M3U8 မဟုတ်ရင် (MP4) ပုံမှန်အတိုင်း Redirect လုပ်မယ်
      const objectUrl = new URL(`${endpoint}/${bucket}/${video}`);
      const signed = await r2.sign(objectUrl, {
        method: "GET",
        aws: { signQuery: true },
        headers: { "Host": `${creds.accountId}.r2.cloudflarestorage.com` },
        expiresIn: 3600
      });

      // HEAD Check for APK Size
      if (request.method === "HEAD") {
        const r2Res = await fetch(signed.url, { method: "HEAD" });
        const newHeaders = new Headers(r2Res.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        return new Response(null, { status: 200, headers: newHeaders });
      }

      return Response.redirect(signed.url, 307);

    } catch (err: any) {
      return new Response(`Error: ${err.message}`, { status: 500 });
    }
  },
};
