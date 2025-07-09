import { google } from "googleapis";
import { OpenAI } from "openai";
import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import { defineString, defineSecret } from "firebase-functions/params";

setGlobalOptions({
    maxInstances: 10,
    region: "us-central1",
    memory: "1GiB",
    timeoutSeconds: 540,
});

const spreadsheetId = defineString("SPREADSHEET_ID", {
    description: "Google Sheets ID for phone price data",
    default: "1baiOHh8zl7Zl44rgiZqD0tKlE428yk-Yr8R8k8XJC8w",
});

const openaiApiKey = defineSecret("OPENAI_API_KEY", {
    description: "OpenAI API key for natural language processing",
});

const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });

// 시트 파싱 함수
async function parseFullSheetStructure(spreadsheetId) {
    const sheetNames = await listSheetNames(spreadsheetId);
    if (sheetNames.length === 0) {
        throw new Error("시트 목록을 가져올 수 없습니다.");
    }

    const allRecords = [];
    const servicesBySheet = {}; // 시트별 부가서비스 정보 저장

    for (const sheetName of sheetNames) {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: `${sheetName}!A1:N100`,
            valueRenderOption: "UNFORMATTED_VALUE",
            dateTimeRenderOption: "FORMATTED_STRING",
        });
        const rows = res.data.values || [];

        if (rows.length < 3) continue;

        const sheetInfo = parseSheetInfo(sheetName);
        const sheetServices = []; // 현재 시트의 부가서비스 정보들

        // 먼저 시트 전체를 스캔하여 부가서비스 정보 수집
        for (let i = 2; i < rows.length; i++) {
            const row = rows[i];
            if (!row[0] || row[0].trim() === "") continue;

            // 부가서비스 정보 (K, L, M, N열) 수집
            if (
                row[10] &&
                row[10].toString().trim() !== "" &&
                row[10].toString().trim() !== "테스트"
            ) {
                const serviceInfo = {
                    serviceName: row[10].toString().trim(),
                    monthlyFee:
                        row[11] && row[11].toString().trim() !== ""
                            ? cleanPrice(row[11])
                            : "0",
                    duration:
                        row[12] && row[12].toString().trim() !== ""
                            ? row[12].toString().trim()
                            : "",
                    additionalFee:
                        row[13] && row[13].toString().trim() !== ""
                            ? cleanPrice(row[13])
                            : "0",
                };

                // 테스트 데이터 필터링
                if (
                    !serviceInfo.monthlyFee.includes("33333333333333") &&
                    !serviceInfo.additionalFee.includes("33333333333333")
                ) {
                    // 중복 제거
                    const serviceKey = `${serviceInfo.serviceName}_${serviceInfo.monthlyFee}_${serviceInfo.duration}_${serviceInfo.additionalFee}`;
                    if (
                        !sheetServices.find(
                            (s) =>
                                `${s.serviceName}_${s.monthlyFee}_${s.duration}_${s.additionalFee}` ===
                                serviceKey
                        )
                    ) {
                        sheetServices.push(serviceInfo);
                        console.log(
                            `시트 ${sheetName}에서 부가서비스 발견:`,
                            serviceInfo
                        );
                    }
                }
            }
        }

        servicesBySheet[sheetName] = sheetServices;

        // 이제 각 행의 데이터를 처리하여 레코드 생성
        for (let i = 2; i < rows.length; i++) {
            const row = rows[i];
            if (!row[0] || row[0].trim() === "") continue;

            // 번호이동 정보 (A, B, C, D열)
            if (row[0] && row[1] && row[3]) {
                const record = {
                    modelRaw: row[0].trim(),
                    modelNorm: normalizeModelName(row[0].trim()),
                    capacity: normalizeCapacity(row[2]),
                    telecom: sheetInfo.telecom,
                    type: "번호이동",
                    channel: sheetInfo.channel,
                    plan: cleanPrice(row[1]),
                    price: cleanPrice(row[3]),
                    serviceInfo:
                        sheetServices.length > 0 ? sheetServices : null,
                };
                allRecords.push(record);
            }

            // 기기변경 정보 (F, G, H, I열)
            if (row[5] && row[6] && row[8]) {
                const record = {
                    modelRaw: row[5].trim(),
                    modelNorm: normalizeModelName(row[5].trim()),
                    capacity: normalizeCapacity(row[7]),
                    telecom: sheetInfo.telecom,
                    type: "기기변경",
                    channel: sheetInfo.channel,
                    plan: cleanPrice(row[6]),
                    price: cleanPrice(row[8]),
                    serviceInfo:
                        sheetServices.length > 0 ? sheetServices : null,
                };
                allRecords.push(record);
            }
        }
    }

    return { allRecords };
}

// 시트 목록 가져오기
async function listSheetNames(spreadsheetId) {
    try {
        const response = await sheets.spreadsheets.get({
            spreadsheetId: spreadsheetId,
        });
        return response.data.sheets.map((sheet) => sheet.properties.title);
    } catch (error) {
        console.error("시트 목록을 가져오는 데 실패했습니다:", error.message);
        return [];
    }
}

// 시트 정보 파싱 함수
function parseSheetInfo(sheetName) {
    const telecom = sheetName.includes("SK")
        ? "SK"
        : sheetName.includes("KT")
        ? "KT"
        : sheetName.includes("LG")
        ? "LG"
        : "Unknown";

    const channel = sheetName.includes("온라인")
        ? "온라인"
        : sheetName.includes("내방")
        ? "내방"
        : "Unknown";

    return { telecom, channel };
}

// 모델명 정규화 함수
function normalizeModelName(modelName) {
    return modelName
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/[^a-z0-9ㄱ-ㅎ가-힣]/g, "");
}

// 용량 정규화 함수
function normalizeCapacity(capacity) {
    if (!capacity || capacity === "") return "기본";
    const capacityStr = capacity.toString().trim();
    if (capacityStr === "") return "기본";
    const numbers = capacityStr.match(/\d+/g);
    return numbers && numbers.length > 0 ? numbers[0] : "기본";
}

// 가격 정규화 함수
function cleanPrice(priceStr) {
    if (!priceStr) return "";
    return priceStr.toString().replace(/[^\d-]/g, "");
}

// 가격 포맷팅 함수
function formatPrice(priceStr) {
    if (!priceStr || priceStr === "0" || priceStr === "") return "0";
    return parseInt(priceStr).toLocaleString();
}

// GPT 파싱 함수
async function parseUserInput(userInput, openaiApiKey) {
    try {
        const openai = new OpenAI({ apiKey: openaiApiKey });

        const prompt = `
사용자의 휴대폰 가격 문의를 분석하여 다음 정보를 추출해주세요:

사용자 입력: "${userInput}"

다음 JSON 형태로만 응답해주세요:
{
    "브랜드": "갤럭시 또는 아이폰",
    "기본모델": "기본 모델명",
    "옵션": "추가 옵션",
    "용량": "숫자만 (예: 128, 256, 512)",
    "통신사": "SK, KT, LG 중 하나",
    "타입": "번호이동 또는 기기변경"
}

규칙:
- 브랜드: 갤럭시/Galaxy → "갤럭시", 아이폰/iPhone → "아이폰"
- 기본모델: S24, S25, 16, 15, 플립6, 폴드6 등 기본 모델명만 (Z 제외)
- 옵션: 플러스, 울트라, 프로, 프로맥스, 엣지, SE, FE, Plus, Ultra, Pro, Pro Max, Edge 등
- 용량: 128, 256, 512 등 숫자만
- 통신사: SK, KT, LG만 인식
- 타입: 번호이동/번이 → "번호이동", 기기변경/기변 → "기기변경"
- 정보가 없으면 null
- "+"는 "플러스"로 정규화

중요한 모델명 정규화:
- Z플립, Z 플립, 플립 → "플립" (또는 해당 숫자)
- Z폴드, Z 폴드, 폴드 → "폴드" (또는 해당 숫자)
- 순수한 숫자(16, 15, 14, 13)는 아이폰 모델로 인식
- +, plus, 플러스 → 모두 "플러스"로 정규화

예시:
- "갤럭시 S24 울트라" → 기본모델: "S24", 옵션: "울트라"
- "아이폰 16 프로맥스" → 기본모델: "16", 옵션: "프로맥스"
- "아이폰 16 SE" → 기본모델: "16", 옵션: "SE"
- "갤럭시 S24 FE" → 기본모델: "S24", 옵션: "FE"
- "갤럭시 Z플립6" → 기본모델: "플립6", 옵션: null
- "갤럭시 플립6" → 기본모델: "플립6", 옵션: null
- "갤럭시 Z폴드6" → 기본모델: "폴드6", 옵션: null
- "갤럭시 폴드6" → 기본모델: "폴드6", 옵션: null
- "갤럭시 S25 엣지" → 기본모델: "S25", 옵션: "엣지"
- "16" → 브랜드: "아이폰", 기본모델: "16"
- "15" → 브랜드: "아이폰", 기본모델: "15"
- "프로" → 브랜드: null, 기본모델: null, 옵션: "프로"
- "맥스" → 브랜드: null, 기본모델: null, 옵션: "맥스"
- "플러스" → 브랜드: null, 기본모델: null, 옵션: "플러스"
- "+" → 브랜드: null, 기본모델: null, 옵션: "플러스"
- "S24+" → 기본모델: "S24", 옵션: "플러스"
- "16+" → 브랜드: "아이폰", 기본모델: "16", 옵션: "플러스"
`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1,
        });

        const responseText = completion.choices[0].message.content.trim();
        console.log("GPT 응답:", responseText);

        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }

        return null;
    } catch (error) {
        console.error("GPT 파싱 실패:", error);
        return null;
    }
}

// 검색 및 응답 생성
function findMatchingRecords(parsedData, allRecords) {
    const { 브랜드, 기본모델, 옵션, 용량, 통신사, 타입 } = parsedData;

    console.log("검색 조건:", parsedData);
    console.log("전체 레코드 수:", allRecords.length);

    let filteredRecords = allRecords;

    // 브랜드 필터링
    if (브랜드) {
        console.log(`브랜드 필터링 시작: ${브랜드}`);
        const beforeBrandFilter = filteredRecords.length;

        filteredRecords = filteredRecords.filter((record) => {
            const modelLower = record.modelRaw.toLowerCase();
            const brandLower = 브랜드.toLowerCase();

            // 갤럭시 브랜드의 경우 플립, 폴드도 포함
            if (brandLower === "갤럭시") {
                return (
                    modelLower.includes("갤럭시") ||
                    modelLower.includes("galaxy") ||
                    modelLower.includes("플립") ||
                    modelLower.includes("폴드")
                );
            }

            return modelLower.includes(brandLower);
        });

        console.log(
            `브랜드 필터링 완료: ${beforeBrandFilter} -> ${filteredRecords.length}`
        );
    }

    // 기본 모델 필터링
    if (기본모델) {
        console.log(`기본모델 필터링 시작: ${기본모델}`);
        const beforeFilter = filteredRecords.length;

        // 플립/폴드 관련 레코드 디버깅
        if (기본모델.includes("플립") || 기본모델.includes("폴드")) {
            console.log("플립/폴드 모델 검색 - 현재 레코드들:");
            filteredRecords.slice(0, 5).forEach((record) => {
                console.log(`- ${record.modelRaw} (${record.capacity}GB)`);
            });
        }

        filteredRecords = filteredRecords.filter((record) => {
            const modelLower = record.modelRaw.toLowerCase();
            const basemodelLower = 기본모델.toLowerCase();

            // 플립과 폴드의 경우 특별 처리 (공백 제거하여 비교)
            if (
                basemodelLower.includes("플립") ||
                basemodelLower.includes("폴드")
            ) {
                // 공백 제거하여 비교
                const modelNoSpace = modelLower.replace(/\s+/g, "");
                const basemodelNoSpace = basemodelLower.replace(/\s+/g, "");
                const result = modelNoSpace.includes(basemodelNoSpace);
                if (result) {
                    console.log(
                        `플립/폴드 매칭: ${record.modelRaw} -> ${basemodelLower} (공백제거: ${modelNoSpace} -> ${basemodelNoSpace})`
                    );
                }
                return result;
            }

            // 옵션이 없으면 정확한 매칭
            if (!옵션) {
                // 기본 모델명이 정확히 일치하는지 확인
                return (
                    modelLower.includes(basemodelLower) &&
                    !modelLower.includes("플러스") &&
                    !modelLower.includes("울트라") &&
                    !modelLower.includes("엣지") &&
                    !modelLower.includes("프로") &&
                    !modelLower.includes("맥스") &&
                    !modelLower.includes("plus") &&
                    !modelLower.includes("ultra") &&
                    !modelLower.includes("edge") &&
                    !modelLower.includes("pro") &&
                    !modelLower.includes("max") &&
                    !modelLower.includes("se") &&
                    !modelLower.includes("fe")
                );
            } else {
                // 옵션이 있으면 기본 포함 검색
                return modelLower.includes(basemodelLower);
            }
        });

        console.log(
            `기본모델 필터링 완료: ${beforeFilter} -> ${filteredRecords.length}`
        );
    }

    // 옵션 필터링
    if (옵션) {
        filteredRecords = filteredRecords.filter((record) => {
            const modelLower = record.modelRaw.toLowerCase();
            const optionLower = 옵션.toLowerCase();

            // 한글 옵션을 영문으로 변환해서 검색
            if (optionLower === "프로") {
                return (
                    modelLower.includes("pro") || modelLower.includes("프로")
                );
            } else if (optionLower === "맥스") {
                return (
                    modelLower.includes("max") || modelLower.includes("맥스")
                );
            } else if (optionLower === "플러스") {
                return (
                    modelLower.includes("plus") ||
                    modelLower.includes("플러스") ||
                    modelLower.includes("+")
                );
            } else if (optionLower === "울트라") {
                return (
                    modelLower.includes("ultra") ||
                    modelLower.includes("울트라")
                );
            } else if (optionLower === "엣지") {
                return (
                    modelLower.includes("edge") || modelLower.includes("엣지")
                );
            } else if (optionLower === "se") {
                return modelLower.includes("se");
            } else if (optionLower === "fe") {
                return modelLower.includes("fe");
            } else {
                return modelLower.includes(optionLower);
            }
        });
    }

    // 용량 필터링
    if (용량) {
        console.log(`용량 필터링 시작: ${용량}`);
        const beforeCapacityFilter = filteredRecords.length;

        // 플립/폴드의 경우 용량 정보 디버깅
        if (
            기본모델 &&
            (기본모델.includes("플립") || 기본모델.includes("폴드"))
        ) {
            console.log("플립/폴드 용량 필터링 전 레코드들:");
            filteredRecords.forEach((record) => {
                console.log(
                    `- ${record.modelRaw}: capacity="${record.capacity}"`
                );
            });
        }

        filteredRecords = filteredRecords.filter(
            (record) => record.capacity === 용량 || record.capacity === "기본"
        );

        console.log(
            `용량 필터링 완료: ${beforeCapacityFilter} -> ${filteredRecords.length}`
        );
    }

    // 통신사 필터링
    if (통신사) {
        filteredRecords = filteredRecords.filter(
            (record) => record.telecom === 통신사
        );
    }

    // 타입 필터링
    if (타입) {
        filteredRecords = filteredRecords.filter(
            (record) => record.type === 타입
        );
    }

    console.log("검색 결과:", filteredRecords.length, "개");
    return filteredRecords;
}

// 응답 생성 함수
function generateResponse(parsedData, matchingRecords) {
    if (matchingRecords.length === 0) {
        return "해당 조건의 상품을 찾을 수 없습니다. 다른 조건으로 검색해보세요.";
    }

    const { 브랜드, 기본모델, 옵션, 용량, 통신사, 타입 } = parsedData;

    // 용량이 있으면 상세한 가격 정보 출력
    if (용량) {
        return generateDetailedResponse(parsedData, matchingRecords);
    }

    // 용량이 없으면 모델명 목록만 출력
    const uniqueModels = [...new Set(matchingRecords.map((r) => r.modelRaw))];

    let result = `📱 검색 결과`;

    // 검색 조건 표시
    if (브랜드 || 기본모델 || 옵션) {
        let displayText = "";

        // 브랜드와 기본모델을 조합
        if (브랜드 && 기본모델) {
            displayText = `${브랜드} ${기본모델}`;
        } else if (브랜드) {
            displayText = 브랜드;
        } else if (기본모델) {
            // 기본모델을 보고 브랜드 자동 판단
            if (
                기본모델.includes("16") ||
                기본모델.includes("15") ||
                기본모델.includes("14") ||
                기본모델.includes("13")
            ) {
                displayText = `아이폰 ${기본모델}`;
            } else {
                displayText = `갤럭시 ${기본모델}`;
            }
        } else if (옵션) {
            // 옵션만 있을 때
            displayText = 옵션;
        }

        // 옵션 추가 (브랜드나 기본모델이 있을 때만)
        if (옵션 && displayText && displayText !== 옵션) {
            displayText += ` ${옵션}`;
        }

        result += ` (${displayText})`;
    }

    result += ` - ${uniqueModels.length}개 모델:\n\n`;

    uniqueModels.slice(0, 10).forEach((model, index) => {
        const modelRecords = matchingRecords.filter(
            (r) => r.modelRaw === model
        );
        const capacities = [...new Set(modelRecords.map((r) => r.capacity))];

        result += `${index + 1}. ${model}`;
        if (capacities.length > 0 && capacities[0] !== "기본") {
            result += ` (${capacities.join(", ")}GB)`;
        }
        result += "\n";
    });

    if (uniqueModels.length > 10) {
        result += `\n... 외 ${uniqueModels.length - 10}개 모델`;
    }

    result += "\n\n💡 자세한 가격을 보려면 용량과 통신사를 함께 말씀해주세요.";

    return result;
}

// 상세 가격 정보 생성 함수
function generateDetailedResponse(parsedData, matchingRecords) {
    const { 브랜드, 기본모델, 옵션, 용량, 통신사, 타입 } = parsedData;

    let result = `💰 가격 정보`;

    // 검색 조건 표시
    let displayText = "";
    if (브랜드 && 기본모델) {
        displayText = `${브랜드} ${기본모델}`;
    } else if (브랜드) {
        displayText = 브랜드;
    } else if (기본모델) {
        // 기본모델을 보고 브랜드 자동 판단
        if (
            기본모델.includes("16") ||
            기본모델.includes("15") ||
            기본모델.includes("14") ||
            기본모델.includes("13")
        ) {
            displayText = `아이폰 ${기본모델}`;
        } else {
            displayText = `갤럭시 ${기본모델}`;
        }
    }

    if (옵션 && displayText && displayText !== 옵션) {
        displayText += ` ${옵션}`;
    } else if (옵션) {
        displayText = 옵션;
    }

    if (용량) {
        displayText += ` ${용량}GB`;
    }

    result += ` - ${displayText}\n\n`;

    // 채널별로 먼저 그룹화 (온라인, 내방)
    const groupedByChannel = matchingRecords.reduce((acc, record) => {
        if (!acc[record.channel]) {
            acc[record.channel] = [];
        }
        acc[record.channel].push(record);
        return acc;
    }, {});

    // 채널별로 출력
    Object.keys(groupedByChannel).forEach((channel) => {
        const channelIcon = channel === "온라인" ? "📦" : "🏬";
        result += `${channelIcon} ${channel} 가격 조건 안내\n\n`;

        const channelRecords = groupedByChannel[channel];

        // 통신사별로 그룹화
        const groupedByTelecom = channelRecords.reduce((acc, record) => {
            if (!acc[record.telecom]) {
                acc[record.telecom] = [];
            }
            acc[record.telecom].push(record);
            return acc;
        }, {});

        Object.keys(groupedByTelecom).forEach((telecom) => {
            const telecomRecords = groupedByTelecom[telecom];

            // 타입별로 그룹화
            const groupedByType = telecomRecords.reduce((acc, record) => {
                if (!acc[record.type]) {
                    acc[record.type] = [];
                }
                acc[record.type].push(record);
                return acc;
            }, {});

            Object.keys(groupedByType).forEach((type) => {
                const typeRecords = groupedByType[type];

                if (typeRecords.length > 0) {
                    const record = typeRecords[0];

                    result += `📱 ${telecom} ${type}\n`;
                    result += `✅ 할부원금: ${parseInt(
                        record.price
                    ).toLocaleString()}원\n`;
                    result += `✅ 요금제: 월 ${parseInt(
                        record.plan
                    ).toLocaleString()}원\n`;

                    // 부가서비스 정보가 있는 모든 레코드 찾기
                    const recordsWithService = typeRecords.filter(
                        (r) =>
                            r.serviceInfo &&
                            Array.isArray(r.serviceInfo) &&
                            r.serviceInfo.length > 0
                    );

                    if (recordsWithService.length > 0) {
                        // 모든 부가서비스 정보 수집
                        const allServices = [];
                        recordsWithService.forEach((r) => {
                            if (r.serviceInfo && Array.isArray(r.serviceInfo)) {
                                allServices.push(...r.serviceInfo);
                            }
                        });

                        // 부가서비스별로 그룹화 (중복 제거)
                        const uniqueServices = allServices.reduce(
                            (acc, service) => {
                                const serviceKey = `${service.serviceName}_${service.monthlyFee}_${service.duration}_${service.additionalFee}`;
                                if (!acc[serviceKey]) {
                                    acc[serviceKey] = service;
                                }
                                return acc;
                            },
                            {}
                        );

                        const services = Object.values(uniqueServices);

                        if (services.length > 0) {
                            // 공통 유지기간 찾기
                            const durations = services
                                .map((s) => s.duration)
                                .filter((d) => d && d !== "");
                            const commonDuration =
                                durations.length > 0 ? durations[0] : "";

                            result += `✅ 부가서비스`;
                            if (commonDuration) {
                                result += ` (${commonDuration} 유지)`;
                            }
                            result += `\n`;

                            // 부가서비스 목록 출력
                            services.forEach((service) => {
                                result += ` - ${service.serviceName}`;

                                // 월 청구금이 있고 0이 아닌 경우
                                if (
                                    service.monthlyFee &&
                                    service.monthlyFee !== "0" &&
                                    service.monthlyFee !== ""
                                ) {
                                    const fee = parseInt(service.monthlyFee);
                                    if (fee >= 10000) {
                                        result += `: ${Math.floor(
                                            fee / 10000
                                        )}만`;
                                        if (fee % 10000 !== 0) {
                                            result += `${fee % 10000}`;
                                        }
                                        result += `원`;
                                    } else {
                                        result += `: ${fee.toLocaleString()}원`;
                                    }
                                }

                                result += `\n`;
                            });

                            // 미가입 시 추가금이 있는 서비스들 수집
                            const servicesWithAdditionalFee = services.filter(
                                (service) =>
                                    service.additionalFee &&
                                    service.additionalFee !== "0" &&
                                    service.additionalFee !== ""
                            );

                            if (servicesWithAdditionalFee.length > 0) {
                                result += `❗ 부가 미가입 시\n`;
                                servicesWithAdditionalFee.forEach((service) => {
                                    const fee = parseInt(service.additionalFee);
                                    let feeText = "";
                                    if (fee >= 10000) {
                                        feeText = `+${Math.floor(
                                            fee / 10000
                                        )}만`;
                                        if (fee % 10000 !== 0) {
                                            feeText += `${fee % 10000}`;
                                        }
                                        feeText += `원`;
                                    } else {
                                        feeText = `+${fee.toLocaleString()}원`;
                                    }
                                    result += ` - ${service.serviceName} 미가입: ${feeText}\n`;
                                });
                            }
                        }
                    }

                    result += `\n`;
                }
            });
        });

        result += `\n`;
    });

    return result;
}

// 메인 함수
async function processUserQuery(userInput, openaiApiKey) {
    try {
        console.log("사용자 입력:", userInput);

        // 1. 시트 데이터 가져오기
        const { allRecords } = await parseFullSheetStructure(
            spreadsheetId.value()
        );
        console.log("총 레코드 수:", allRecords.length);

        // 2. GPT로 입력 파싱
        const parsedData = await parseUserInput(userInput, openaiApiKey);
        if (!parsedData) {
            return "질문을 이해할 수 없습니다. 다시 말씀해주세요.";
        }

        // 3. 검색 실행
        const matchingRecords = findMatchingRecords(parsedData, allRecords);

        // 디버깅: 검색된 레코드 중 부가서비스가 있는 레코드들 출력
        const recordsWithServices = matchingRecords.filter(
            (r) =>
                r.serviceInfo &&
                Array.isArray(r.serviceInfo) &&
                r.serviceInfo.length > 0
        );
        console.log("=== 검색된 레코드 중 부가서비스가 있는 레코드들 ===");
        recordsWithServices.forEach((r) => {
            console.log(
                `${r.telecom} ${r.channel} ${r.type} - ${
                    r.modelRaw
                }: ${r.serviceInfo.map((s) => s.serviceName).join(", ")}`
            );
        });

        // 4. 응답 생성
        return generateResponse(parsedData, matchingRecords);
    } catch (error) {
        console.error("처리 중 오류:", error);
        return "죄송합니다. 처리 중 오류가 발생했습니다.";
    }
}

// Firebase Functions
export const kakaoSkill = onRequest(
    {
        secrets: [openaiApiKey],
        cors: true,
    },
    async (req, res) => {
        try {
            const userInput = req.body?.userRequest?.utterance;

            if (!userInput) {
                return res.status(400).json({
                    version: "2.0",
                    template: {
                        outputs: [
                            {
                                simpleText: {
                                    text: "질문을 입력해주세요.",
                                },
                            },
                        ],
                    },
                });
            }

            const response = await processUserQuery(
                userInput,
                openaiApiKey.value()
            );

            res.json({
                version: "2.0",
                template: {
                    outputs: [
                        {
                            simpleText: {
                                text: response,
                            },
                        },
                    ],
                },
            });
        } catch (error) {
            console.error("KakaoSkill Error:", error);
            res.status(500).json({
                version: "2.0",
                template: {
                    outputs: [
                        {
                            simpleText: {
                                text: "서비스에 문제가 발생했습니다. 잠시 후 다시 시도해주세요.",
                            },
                        },
                    ],
                },
            });
        }
    }
);

export const phonePrice = onRequest(
    {
        secrets: [openaiApiKey],
        cors: true,
    },
    async (req, res) => {
        try {
            const userInput = req.body?.query || req.query?.q;

            if (!userInput) {
                return res.status(400).json({
                    error: "질문을 입력해주세요.",
                });
            }

            const response = await processUserQuery(
                userInput,
                openaiApiKey.value()
            );

            res.json({
                query: userInput,
                response: response,
            });
        } catch (error) {
            console.error("PhonePrice Error:", error);
            res.status(500).json({
                error: "서비스에 문제가 발생했습니다.",
            });
        }
    }
);
