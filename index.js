// index.js
require("dotenv").config();
const { google } = require("googleapis");
const { OpenAI } = require("openai");
const stringSimilarity = require("string-similarity");

// —————— 1) 환경 변수 & 상수 ——————
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const CRED_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const ONLINE_TAB = "MNP(온라인)";
const INSTORE_TAB = "MNP(내방)";
const TELECOMS = ["SK", "KT", "LG"];

// —————— 2) 클라이언트 초기화 ——————
const auth = new google.auth.GoogleAuth({
    keyFile: CRED_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// —————— 3) 시트 파싱: “갤럭시…256” 등 mini-table 읽기 ——————
async function parseSheetRecords(tabName, label) {
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${tabName}!A1:Z200`,
    });
    const rows = res.data.values || [];
    const recs = [];

    for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < rows[i].length; j++) {
            const cell = (rows[i][j] || "").toString().trim();
            const m = cell.match(/(갤럭시|아이폰)\s*(\S*?)\s*(\d+)(?:GB)?/i);
            if (!m) continue;

            const modelRaw = (m[1] + (m[2] || "")).replace(/\s+/g, "");
            const modelNorm = modelRaw.toLowerCase();
            const capacity = m[3];
            const groupIdx = Math.floor(j / 2);
            const telecom = TELECOMS[groupIdx] || "";
            const type = groupIdx % 2 === 0 ? "번호이동" : "기기변경";

            let price = "",
                plan = "",
                extras = "";
            for (let k = i + 1; k < rows.length; k++) {
                const labelCell = (rows[k][j] || "").toString().trim();
                const valCell = (rows[k][j + 1] || "")
                    .toString()
                    .trim()
                    .replace(/원$/, "");
                if (!labelCell) break;
                if (/출고가|MNP전환지원금|실제\s*구매가격/.test(labelCell))
                    price = valCell;
                else if (/요금제/.test(labelCell)) plan = valCell;
                else if (/부가서비스/.test(labelCell)) extras = valCell;
                else break;
            }

            recs.push({
                sheet: label,
                modelRaw,
                modelNorm,
                capacity,
                telecom,
                type,
                price,
                plan,
                extras,
            });
        }
    }

    console.log(`▶ [${label}] 파싱된 레코드 수:`, recs.length);
    console.log(`▶ [${label}] 레코드 샘플:`, recs.slice(0, 5));
    return recs;
}

// —————— 4) 질문 파싱 ——————
function parseQuestion(q) {
    const m = q.match(
        /(갤럭시|아이폰)\s*(\S*?)\s+(\d+)(?:GB)?\s*(SKT|KT|LG)?/i
    );
    if (!m)
        throw new Error(
            "“갤럭시/아이폰 + 용량 [+ 통신사]” 형식으로 질문해주세요."
        );
    const modelNorm = (m[1] + (m[2] || "")).replace(/\s+/g, "").toLowerCase();
    const capacity = m[3];
    const operator = m[4]?.toUpperCase();
    console.log(
        `▶ 질문 파싱 -> model: ${modelNorm}, capacity: ${capacity}, operator: ${
            operator || "전체"
        }`
    );
    return { modelNorm, capacity, operator };
}

// —————— 5) 모델 fuzzy 매칭 ——————
function findBestModel(modelNorm, candidates) {
    const { bestMatch } = stringSimilarity.findBestMatch(modelNorm, candidates);
    console.log(
        `▶ fuzzy 매칭 -> bestModel: ${bestMatch.target} (${bestMatch.rating})`
    );
    return bestMatch.target;
}

// —————— 6) GPT 포맷용 프롬프트 생성 ——————
async function formatWithGPT(question, onMatches, inMatches) {
    const block = (label, arr) => {
        if (arr.length === 0) return `✅ ${label} 가격 조건:\n- 정보 없음\n\n`;
        return (
            `✅ ${label} 가격 조건:\n` +
            arr
                .map(
                    (r) =>
                        `- ${r.telecom} ${r.type}: 할부원금 ${
                            r.price
                        }원, 요금제 ${r.plan}원, 부가서비스 ${
                            r.extras || "없음"
                        }`
                )
                .join("\n") +
            "\n\n"
        );
    };

    const onlineBlock = block("온라인", onMatches);
    const instoreBlock = block("내방", inMatches);

    const prompt = `
아래는 코드가 시트에서 직접 꺼낸 **정확한** 가격 데이터입니다.

${onlineBlock}${instoreBlock}
위 데이터를 참고하여, “✅ 온라인 가격 조건”과 “✅ 내방 가격 조건” 두 블록을
고객이 보기 좋게 다시 한 번만 깔끔히 정리해 주세요.
고객 질문: ${question}
  `.trim();

    console.log("▶ GPT 프롬프트:", prompt.replace(/\n/g, " ⏎ "));

    const res = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
            {
                role: "system",
                content:
                    "당신은 숙련된 휴대폰 요금 상담 챗봇입니다. 데이터만 참고하세요.",
            },
            { role: "user", content: prompt },
        ],
    });
    return res.choices[0].message.content;
}

// —————— 7) 메인 ——————
(async () => {
    try {
        const question = process.argv.slice(2).join(" ");
        if (!question) {
            console.error('⛔ 사용법: node index.js "갤럭시 S25 256 [SKT]"');
            process.exit(1);
        }

        console.log("⏳ 데이터 파싱 중…");
        const [onlineRecs, instoreRecs] = await Promise.all([
            parseSheetRecords(ONLINE_TAB, "온라인"),
            parseSheetRecords(INSTORE_TAB, "내방"),
        ]);
        const allRecs = onlineRecs.concat(instoreRecs);

        const availableModels = Array.from(
            new Set(allRecs.map((r) => r.modelNorm))
        );
        console.log("▶ 가능한 모델 목록:", availableModels);

        const { modelNorm, capacity, operator } = parseQuestion(question);
        const bestModel = findBestModel(modelNorm, availableModels);

        const filtered = allRecs.filter(
            (r) =>
                r.modelNorm === bestModel &&
                r.capacity === capacity &&
                (!operator || r.telecom === operator)
        );
        console.log("▶ 필터된 레코드 수:", filtered.length);
        console.log("▶ 필터 샘플:", filtered.slice(0, 5));

        const onlineMatches = filtered.filter((r) => r.sheet === "온라인");
        const instoreMatches = filtered.filter((r) => r.sheet === "내방");

        console.log("⏳ GPT로 포맷 요청…");
        const answer = await formatWithGPT(
            question,
            onlineMatches,
            instoreMatches
        );

        console.log("\n📤 최종 답변:\n", answer.trim());
    } catch (err) {
        console.error("\n[ERROR]", err.message);
        process.exit(1);
    }
})();
