const UniswapV3AutoTrader = require('./src/UniswapV3Trader');
const config = require('./config');

async function main() {
    const trader = new UniswapV3AutoTrader(
        config.RPC_URL,
        config.PRIVATE_KEY,
        config.SLIPPAGE_TOLERANCE
    );

    try {
        // 示例1: 交换USDC -> WETH
        // const result = await trader.swapTokens(
        //     trader.tokens.USDC,
        //     trader.tokens.WETH,
        //     100 // 100 USDC
        // );
        // console.log('交换结果:', result);

        // 示例2: 添加 WETH/USDC 流动性
        // const liquidityResult = await trader.addLiquidity(
        //     trader.tokens.WETH,
        //     trader.tokens.USDC,
        //     3000, // 0.3% fee tier
        //     0.1,  // 0.1 WETH
        //     300,  // 300 USDC
        //     TickMath.getSqrtRatioAtTick(-887220), // min price
        //     TickMath.getSqrtRatioAtTick(887220)   // max price
        // );

        // 示例3: 价格监控和自动交易
        await trader.startPriceMonitoring(
            trader.tokens.WETH,
            trader.tokens.USDC,
            3000, // 0.3% fee tier
            3000, // 当WETH价格低于3000 USDC时买入
            'buy',
            100   // 使用100 USDC买入
        );

    } catch (error) {
        console.error('操作失败:', error);
    }
}

main().catch(console.error);
