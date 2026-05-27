import { ClobClient,Side } from "@polymarket/clob-client-v2";
import axios from "axios";
import {HttpsProxyAgent } from "https-proxy-agent";
import { DateTime } from "luxon";
import { PolymarketOrderExecutor } from "./Order";

// 配置参数
let prefix = "btc-updown-5m-";
let TARGET_SLUG = "btc-updown-5m-"; 
let time:any = DateTime.now().setZone("America/New_York");
let minuteTime:any = Math.floor(time/1000);
let nowTime:any = Math.floor(minuteTime/300)*300;
TARGET_SLUG+=nowTime;
console.log("slug:"+TARGET_SLUG);

//let timeNow:any = Math.floor(DateTime.now().setZone("America/New_York") / 1000);
//TARGET_SLUG+=timeNow;
const POLL_INTERVAL_MS = 2000; // 轮询时间间隔：2000毫秒（2秒），可根据实际需求调整为 1000 - 5000ms

const LOCAL_PROXY_URL="http://127.0.0.1:10809";
const proxyAgent = new HttpsProxyAgent(LOCAL_PROXY_URL);

// 官方接口地址
let GAMMA_API = "https://gamma-api.polymarket.com/events/slug/";
const GAMMA_API_URL = "https://gamma-api.polymarket.com/events/slug/"+TARGET_SLUG;
// const GAMMA_API_URL = "https://polymarket.com";
const CLOB_API_URL = "https://polymarket.com";

interface MarketTokens {
    yesTokenId: string;
    noTokenId: string;
    title: string;
}

export class PolymarketPollingEngine {
    private slug: string;
    private intervalMs: number;
    private tokens: MarketTokens | null = null;
    private isRunning: boolean = false;
    private timer: NodeJS.Timeout | null = null;
    private client:ClobClient;

    private isBuy:boolean=false;
    private buyShare:string;
    private lastBuy:boolean = false;// 上一个时期买的方向，true为yes  false为no

    constructor(slug: string, intervalMs: number, clobClient:ClobClient, buyShare:string) {
        this.slug = slug;
        this.intervalMs = intervalMs;
        this.client = clobClient;
        this.buyShare = buyShare;
    }

    /**
     * 1. 动态获取最新的 Token ID (带有10位时间戳穿透缓存)
     */
    private async fetchDynamicTokens(): Promise<MarketTokens> {
        let time : any = DateTime.now().setZone("America/New_York");
        let timestamp10 :any = Math.floor(time / 1000);
        try {
            console.log('市场slug：'+this.slug);
            console.log("gamma_api:"+GAMMA_API_URL);
            const response = await axios.get(GAMMA_API_URL, {
                params: {
                    // slug: this.slug,
                    // _ts: timestamp10
                }
            });

            const markets = response.data;
            console.log("id:"+markets.id)
            if (!markets || markets.length === 0) {
                throw new Error(`未找到该 slug 对应的活跃市场: ${this.slug}`);
            }

            const activeMarket = markets.markets;
            // console.log("activeMarket");
            // console.log(activeMarket);
            // console.log("activemarket id:");
            // console.log(activeMarket[0]);
            // console.log("clobTokenIds:")
            // console.log(activeMarket[0].clobTokenIds);
            const tokensArray = activeMarket[0].clobTokenIds;
            if (!tokensArray || tokensArray.length < 2) {
                throw new Error("该市场不属于二元预测市场（缺少 YES/NO 代币配对）");
            }

            // const yesToken = tokensArray.find((t: any) => t.outcome.toLowerCase() === "yes");
            // const noToken = tokensArray.find((t: any) => t.outcome.toLowerCase() === "no");
            let toArrayToken:string[] = JSON.parse(tokensArray);
            console.log("toArrayToken:");
            console.log(toArrayToken);
            console.log("array length:"+toArrayToken.length);
            let yesToken = toArrayToken[0];
            console.log("yesToken:");
            console.log(yesToken);
            let noToken = toArrayToken[1];
            console.log("title:");
            console.log(activeMarket[0].question);

            if (!yesToken || !noToken) {
                throw new Error("无法精准匹配到 YES 或 NO 的 TokenID");
            }

            return {
                yesTokenId: yesToken,
                noTokenId: noToken,
                title: activeMarket[0].question
            };
        } catch (error: any) {
            console.error("❌ 动态获取 Token ID 失败:", error.message);
            throw error;
        }
    }

    /**
     * 2. 启动轮询引擎
     */
    public async start() {
        try {
            this.tokens = await this.fetchDynamicTokens();
            console.log(`\n=================== 🎯 轮询目标市场锁定 ===================`);
            console.log(`标题: ${this.tokens.title}`);
            console.log(`YES Token ID: ${this.tokens.yesTokenId}`);
            console.log(`NO  Token ID: ${this.tokens.noTokenId}`);
            console.log(`⏱️  轮询频率: 每 ${this.intervalMs / 1000} 秒请求一次`);
            console.log(`===========================================================\n`);

            this.isRunning = true;
            this.executePoll(); // 立即执行第一次轮询
        } catch (err) {
            console.error("🏁 轮询引擎启动失败。");
        }
    }

    /**
     * 3. 核心轮询控制逻辑
     * 使用递归的 setTimeout 代替 setInterval，防止在上一次网络请求未返回时叠加发起新的请求
     */
    private async executePoll() {
        if (!this.isRunning || !this.tokens) return;

        const timestamp10 = Math.floor(DateTime.now().setZone("America/New_York").toSeconds()) - 5;
        const timestamp11 = Math.floor(timestamp10/300)*300;
        console.log("this.slug:"+this.slug);
        console.log("timestampNow:"+timestamp11);
        if(this.slug!=timestamp11){
          this.slug = "https://gamma-api.polymarket.com/events/slug/"+prefix + timestamp11;
          this.tokens = await this.fetchDynamicTokens();
          setTimeout(() => this.executePoll(), this.intervalMs);
        }
        try {
            // 本地用  使用代理  同时发起 YES 和 NO 两个盘口的单次 REST 请求
            /*
            const response = await axios.post( "https://clob.polymarket.com/midpoints", [
            { tokenId: this.tokens.yesTokenId },
            { tokenId: this.tokens.noTokenId }
            ], {
                params:{
                    _ts:timestamp10
                }
            });
            console.log("response");
            console.log(response);

            // 结构类似于: { "midpoints": { "437461498...": "0.550", "4871046...": "0.450" } }
            const payloadData = response.data;
            
            // 动态兼容外壳：部分环境最外层有 .midpoints 包裹，部分环境是扁平的
            const midpointsMap = payloadData?.midpoints ? payloadData.midpoints : payloadData;

            // 🟢 核心修正 3：精准提取对应的字符串价格
            const yesMidStr = midpointsMap[this.tokens.yesTokenId];
            const noMidStr = midpointsMap[this.tokens.noTokenId];

            // 强转为纯正的 number，彻底消除类型拦截
            const yesPrice = yesMidStr ? parseFloat(yesMidStr) : 0;
            const noPrice = noMidStr ? parseFloat(noMidStr) : 0;*/

            // const [yesPriceRes, noPriceRes] = await Promise.all([
                // axios.get(CLOB_API_URL, {httpsAgent: proxyAgent,proxy:false, params: { token_id: this.tokens.yesTokenId } }),
                // axios.get(CLOB_API_URL, {httpsAgent: proxyAgent,proxy:false, params: { httpsAgent: proxyAgent,token_id: this.tokens.noTokenId } })
                // this.client.getPrice( this.tokens.yesTokenId ,"sell"),
                // this.client.getPrice(this.tokens.noTokenId ,"sell")
            // ]);
            // /*const pricesPayload = await this.client.getPrices([
            // { token_id: this.tokens.yesTokenId, side: Side.SELL }, // 查 YES 卖一价
            // { token_id: this.tokens.noTokenId, side: Side.SELL }   // 查 NO  卖一价
            // ]);*/
            // console.log("yespriceRes:");
            // console.log(yesPriceRes);
            // const yesPrice = yesPriceRes?.data ? parseFloat(yesPriceRes.data) : (typeof yesPriceRes === 'string' ? parseFloat(yesPriceRes) : 0);
            // const noPrice = noPriceRes?.data ? parseFloat(noPriceRes.data) : (typeof noPriceRes === 'string' ? parseFloat(noPriceRes) : 0);
            /*const yesData = pricesPayload[this.tokens.yesTokenId];
            const noData = pricesPayload[this.tokens.noTokenId];

            const yesPrice = yesData?.sell ? parseFloat(yesData.sell) : 0;
            const noPrice = noData?.sell ? parseFloat(noData.sell) : 0;*/

            // const [yesBook, noBook] = await Promise.all([
            //     this.client.getOrderBook(this.tokens.yesTokenId),
            //     this.client.getOrderBook(this.tokens.noTokenId)
            // ]);
            // const yesPrice = yesBook?.asks?.[0]?.price ? parseFloat(yesBook.asks[0].price) : 0;
            // const noPrice = noBook?.asks?.[0]?.price ? parseFloat(noBook.asks[0].price) : 0;
            // /*查公允价 服务器用
            const midResponse = await this.client.getMidpoints([{
                token_id: this.tokens.yesTokenId,side:Side.SELL},
            {
                token_id: this.tokens.noTokenId, side:Side.SELL
            }]);
            console.log("midResponse:");
            // console.log(midResponse);
            const yesMidStr = midResponse[this.tokens.yesTokenId];
            const noMidStr = midResponse[this.tokens.noTokenId];
            const yesPrice = yesMidStr ? parseFloat(yesMidStr) : 0;
            const noPrice = noMidStr ? parseFloat(noMidStr) : 0;
            
            console.log(`[${new Date().toLocaleTimeString()}] 📊 实时公允价 | YES: $${yesPrice.toFixed(3)} | NO: $${noPrice.toFixed(3)}`);
            
            
            // 解析盘口最优价格
            // const yesBid = yesBookRes.data.bids?.[0]?.price ? parseFloat(yesBookRes.data.bids[0].price) : 0;
            // const yesAsk = yesBookRes.data.asks?.[0]?.price ? parseFloat(yesBookRes.data.asks[0].price) : 0;
            // const noBid = noBookRes.data.bids?.[0]?.price ? parseFloat(noBookRes.data.bids[0].price) : 0;
            // const noAsk = noBookRes.data.asks?.[0]?.price ? parseFloat(noBookRes.data.asks[0].price) : 0;

            // 打印当前的盘口快照
            // console.log(`[${new Date().toLocaleTimeString()}] 📊 YES: [买一 $${yesBid} / 卖一 $${yesAsk}] | NO: [买一 $${noBid} / 卖一 $${noAsk}]`);

            //4. 执行策略计算
            // if (yesPrice > 0 && noPrice > 0) {
            //     if(!this.isBuy){
            //         this.checkStrategy(0, yesPrice, 0, noPrice);
            //     }
            // }
            // 买下一个时期的 在当前时期过去四分钟之后 使用状态位判定是否有下一个时期的持仓（也可以查持仓）   如果有则不下单  没有则看价格  跟高的买   记住上一次买的方向   如果现在的趋势不匹配则将share翻倍
            // 当前时期需要干的事情：1.盯4分钟后的时间看下一个时期买哪个方向   2. 买完方向然后记录下来   3. 对share进行操作根据上一次买的方向以及当前时期的价格

        } catch (error: any) {
            console.error(`⚠️ 轮询捕获到网络异常: ${error.message}，脚本将在下一轮自动重试...`);
        }

        // 递归进入下一轮检测
        if (this.isRunning) {
            this.isBuy = false;
            this.timer = setTimeout(() => this.executePoll(), this.intervalMs);
        }
    }

    /**
     * 5. 第三部分策略接入点 (REST版判别)
     */
    private async checkStrategy(yesBid: number, yesAsk: number, noBid: number, noAsk: number, isBuy:boolean, buyShare:string, slug:string, lastBuy:boolean) {
        if (!this.tokens) return;
        // 查下一个市场的价格
        let time : any = DateTime.now().setZone("America/New_York");
        let timestamp11 :any = Math.floor(time / 1000);
        let nextSlug = parseFloat(slug)+300;
        GAMMA_API="https://gamma-api.polymarket.com/events/slug/"+prefix + nextSlug;
        try {
            console.log('市场slug：'+nextSlug);
            console.log("gamma_api:"+GAMMA_API);
            const response = await axios.get(GAMMA_API, {
                params: {
                    // slug: this.slug,
                    //_ts: timestamp11
                }
            });

            const markets = response.data;
            console.log(markets);
            console.log("id:"+markets.id)
            if (!markets || markets.length === 0) {
                isBuy = false;
                throw new Error(`未找到该 slug 对应的活跃市场: ${this.slug}`);
            }

            const activeMarket = markets.markets;
            console.log("activeMarket");
            console.log(activeMarket);
            console.log("activemarket id:");
            console.log(activeMarket[0]);
            console.log("clobTokenIds:")
            console.log(activeMarket[0].clobTokenIds);
            const tokensArray = activeMarket[0].clobTokenIds;
            if (!tokensArray || tokensArray.length < 2) {
                isBuy = false;
                throw new Error("该市场不属于二元预测市场（缺少 YES/NO 代币配对）");
            }

            // const yesToken = tokensArray.find((t: any) => t.outcome.toLowerCase() === "yes");
            // const noToken = tokensArray.find((t: any) => t.outcome.toLowerCase() === "no");
            let toArrayToken:string[] = JSON.parse(tokensArray);
            console.log("toArrayToken:");
            console.log(toArrayToken);
            console.log("array length:"+toArrayToken.length);
            let yesToken = toArrayToken[0];
            console.log("yesToken:");
            console.log(yesToken);
            let noToken = toArrayToken[1];
            console.log("title:");
            console.log(activeMarket[0].question);

            if (!yesToken || !noToken) {
                isBuy = false;
                throw new Error("无法精准匹配到 YES 或 NO 的 TokenID");
            }

            // 下单
            if(lastBuy){
                // 查价
                const pricesPayload = await this.client.getPrices([{
                    token_id:yesToken,
                    side:Side.SELL
                }]);
                const tokenData = pricesPayload[yesToken];
                const sellPrice = tokenData?.SELL?parseFloat(tokenData.SELL):(tokenData?.sell ? parseFloat(tokenData.sell) : 0);
                console.log(`📡 [SDK查价成功] Token: ...${yesToken.slice(-8)} | 盘口吃单成本: $${sellPrice.toFixed(2)}`);
                let polyOrder = new PolymarketOrderExecutor(this.client);
                polyOrder.executeArbitrageOrders(
                    yesToken,
                    sellPrice.toFixed(2),
                    noToken,
                    "0",
                    buyShare,
                    lastBuy
                )
            } else {
                // 查价
                const pricesPayload = await this.client.getPrices([{
                    token_id:noToken,
                    side:Side.SELL
                }]);
                const tokenData = pricesPayload[noToken];
                const sellPrice = tokenData?.SELL?parseFloat(tokenData.SELL):(tokenData?.sell ? parseFloat(tokenData.sell) : 0);
                console.log(`📡 [SDK查价成功] Token: ...${noToken.slice(-8)} | 盘口吃单成本: $${sellPrice.toFixed(2)}`);
                let polyOrder = new PolymarketOrderExecutor(this.client);
                polyOrder.executeArbitrageOrders(
                    yesToken,
                    "0",
                    noToken,
                    sellPrice.toFixed(2),
                    buyShare,
                    lastBuy
                )
            }

            
        } catch (error: any) {
            isBuy = false;
            console.error("❌ 动态获取 Token ID 失败:", error.message);
            throw error;
        }


        // const instantArbitrageCost = yesAsk + noAsk;
        // const bidSum = yesBid + noBid;

        // 由于是中低频轮询，通常捕捉的是趋势错配或深度较厚的大资金套利机会
        // if (instantArbitrageCost < 0.99) {
        //     const profitMargin = 1 - instantArbitrageCost;
        //     console.log(`🔥 [💥 吃单信号] 发现价差：YES 卖一($${yesAsk}) + NO 卖一($${noAsk}) = $${instantArbitrageCost.toFixed(3)} | 预估收益率: ${(profitMargin * 100).toFixed(2)}%`);
        //     // 此处可调用第四部分的下单方法：this.orderExecutor.placeOrders(...)
        // } else if (bidSum > 1.01) {
        //     console.log(`🚨 [⚖️ 挂单信号] 盘口过热：YES 买一($${yesBid}) + NO 买一($${noBid}) = $${bidSum.toFixed(3)} | 可作为流动性提供者参与反向挂单`);
        // }

        GAMMA_API = "https://gamma-api.polymarket.com/events/slug/";
        
    }

    /**
     * 优雅停止
     */
    public stop() {
        this.isRunning = false;
        if (this.timer) {
            clearTimeout(this.timer);
        }
        console.log("🛑 轮询引擎已安全停止。");
    }
}

// // 启动执行
// const pollingEngine = new PolymarketPollingEngine(TARGET_SLUG, POLL_INTERVAL_MS, ClobClient, 2);
// pollingEngine.start();

// 进程中断处理
process.on("SIGINT", () => {
    executePoll.stop();
    process.exit(0);
});
