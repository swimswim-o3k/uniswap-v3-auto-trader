const { ethers } = require('ethers');
const { Token, CurrencyAmount, TradeType, Percent } = require('@uniswap/sdk-core');
const { Pool, Position, nearestUsableTick, TickMath, TICK_SPACINGS } = require('@uniswap/v3-sdk');
const { AlphaRouter } = require('@uniswap/smart-order-router');

class UniswapV3AutoTrader {
    constructor(provider, walletPrivateKey, slippageTolerance = 0.5) {
        this.provider = new ethers.JsonRpcProvider(provider);
        this.wallet = new ethers.Wallet(walletPrivateKey, this.provider);
        this.slippage = new Percent(slippageTolerance * 100, 10000);
        
        // Uniswap V3 合约地址
        this.SWAP_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
        this.POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
        this.QUOTER_ADDRESS = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
        
        this.router = new AlphaRouter({
            chainId: 1,
            provider: this.provider
        });
        
        // 常用代币
        this.tokens = {
            WETH: new Token(1, "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 18, "WETH", "Wrapped Ether"),
            USDC: new Token(1, "0xA0b86a33E6441b0b5C4C1B89DfC2FbB4e0A0b26D", 6, "USDC", "USD Coin"),
            USDT: new Token(1, "0xdAC17F958D2ee523a2206206994597C13D831ec7", 6, "USDT", "Tether USD"),
            DAI: new Token(1, "0x6B175474E89094C44Da98b954EedeAC495271d0F", 18, "DAI", "Dai Stablecoin")
        };
    }

    async swapTokens(tokenIn, tokenOut, amountIn, recipient = null) {
        try {
            console.log(`准备交换 ${amountIn} ${tokenIn.symbol} -> ${tokenOut.symbol}`);
            
            recipient = recipient || this.wallet.address;
            
            // 创建交换金额
            const amount = CurrencyAmount.fromRawAmount(
                tokenIn,
                ethers.parseUnits(amountIn.toString(), tokenIn.decimals).toString()
            );

            // 获取最优路由
            const route = await this.router.route(
                amount,
                tokenOut,
                TradeType.EXACT_INPUT,
                {
                    recipient,
                    slippageTolerance: this.slippage,
                    deadline: Math.floor(Date.now() / 1000) + 60 * 20, // 20分钟
                }
            );

            if (!route) {
                throw new Error('无法找到交换路由');
            }

            console.log(`预期输出: ${route.quote.toFixed(6)} ${tokenOut.symbol}`);
            console.log(`价格影响: ${route.estimatedGasUsed.toString()}`);

            // 执行交换
            const transaction = {
                data: route.methodParameters.calldata,
                to: this.SWAP_ROUTER_ADDRESS,
                value: route.methodParameters.value,
                from: this.wallet.address,
                gasPrice: await this.provider.getFeeData().then(fee => fee.gasPrice),
                gasLimit: route.estimatedGasUsed.toString(),
            };

            const txResponse = await this.wallet.sendTransaction(transaction);
            console.log(`交易已发送: ${txResponse.hash}`);

            const receipt = await txResponse.wait();
            console.log(`交易已确认: ${receipt.transactionHash}`);

            return {
                txHash: receipt.transactionHash,
                amountIn: amountIn,
                amountOut: route.quote.toSignificant(6),
                gasUsed: receipt.gasUsed.toString()
            };

        } catch (error) {
            console.error('交换失败:', error);
            throw error;
        }
    }

    async addLiquidity(token0, token1, fee, amount0, amount1, minPrice, maxPrice) {
        try {
            console.log(`添加流动性: ${token0.symbol}/${token1.symbol}`);

            // 获取池子信息
            const poolAddress = Pool.getAddress(token0, token1, fee);
            const poolContract = new ethers.Contract(
                poolAddress,
                [
                    'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
                    'function liquidity() external view returns (uint128)',
                    'function tickSpacing() external view returns (int24)'
                ],
                this.provider
            );

            const [slot0, liquidity] = await Promise.all([
                poolContract.slot0(),
                poolContract.liquidity()
            ]);

            const pool = new Pool(
                token0,
                token1,
                fee,
                slot0.sqrtPriceX96.toString(),
                liquidity.toString(),
                slot0.tick
            );

            // 计算tick范围
            const tickSpacing = TICK_SPACINGS[fee];
            const tickLower = nearestUsableTick(
                TickMath.getTickAtSqrtRatio(minPrice),
                tickSpacing
            );
            const tickUpper = nearestUsableTick(
                TickMath.getTickAtSqrtRatio(maxPrice),
                tickSpacing
            );

            // 创建流动性位置
            const position = Position.fromAmounts({
                pool,
                tickLower,
                tickUpper,
                amount0: CurrencyAmount.fromRawAmount(
                    token0,
                    ethers.parseUnits(amount0.toString(), token0.decimals).toString()
                ),
                amount1: CurrencyAmount.fromRawAmount(
                    token1,
                    ethers.parseUnits(amount1.toString(), token1.decimals).toString()
                ),
                useFullPrecision: true,
            });

            // 构建铸造参数
            const mintParams = {
                token0: token0.address,
                token1: token1.address,
                fee: fee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: position.amount0.quotient.toString(),
                amount1Desired: position.amount1.quotient.toString(),
                amount0Min: 0, // 在生产环境中应设置合理的滑点保护
                amount1Min: 0,
                recipient: this.wallet.address,
                deadline: Math.floor(Date.now() / 1000) + 60 * 20,
            };

            // 执行添加流动性
            const positionManager = new ethers.Contract(
                this.POSITION_MANAGER_ADDRESS,
                [
                    'function mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256)) external payable returns (uint256,uint128,uint256,uint256)'
                ],
                this.wallet
            );

            const tx = await positionManager.mint(mintParams);
            const receipt = await tx.wait();

            console.log(`流动性添加成功: ${receipt.transactionHash}`);

            return {
                txHash: receipt.transactionHash,
                tokenId: receipt.events?.find(e => e.event === 'IncreaseLiquidity')?.args?.tokenId,
                liquidity: position.liquidity.toString(),
                amount0: position.amount0.toSignificant(6),
                amount1: position.amount1.toSignificant(6)
            };

        } catch (error) {
            console.error('添加流动性失败:', error);
            throw error;
        }
    }

    async removeLiquidity(tokenId, liquidity, amount0Min = 0, amount1Min = 0) {
        try {
            console.log(`移除流动性 Token ID: ${tokenId}`);

            const positionManager = new ethers.Contract(
                this.POSITION_MANAGER_ADDRESS,
                [
                    'function decreaseLiquidity((uint256,uint128,uint256,uint256,uint256)) external payable returns (uint256,uint256)',
                    'function collect((uint256,address,uint128,uint128)) external payable returns (uint256,uint256)'
                ],
                this.wallet
            );

            // 减少流动性
            const decreaseParams = {
                tokenId: tokenId,
                liquidity: liquidity,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                deadline: Math.floor(Date.now() / 1000) + 60 * 20,
            };

            const decreaseTx = await positionManager.decreaseLiquidity(decreaseParams);
            await decreaseTx.wait();

            // 收集费用和代币
            const collectParams = {
                tokenId: tokenId,
                recipient: this.wallet.address,
                amount0Max: ethers.MaxUint128,
                amount1Max: ethers.MaxUint128,
            };

            const collectTx = await positionManager.collect(collectParams);
            const receipt = await collectTx.wait();

            console.log(`流动性移除成功: ${receipt.transactionHash}`);

            return {
                txHash: receipt.transactionHash,
                gasUsed: receipt.gasUsed.toString()
            };

        } catch (error) {
            console.error('移除流动性失败:', error);
            throw error;
        }
    }

    async getPoolInfo(token0, token1, fee) {
        try {
            const poolAddress = Pool.getAddress(token0, token1, fee);
            const poolContract = new ethers.Contract(
                poolAddress,
                [
                    'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
                    'function liquidity() external view returns (uint128)',
                    'function feeGrowthGlobal0X128() external view returns (uint256)',
                    'function feeGrowthGlobal1X128() external view returns (uint256)'
                ],
                this.provider
            );

            const [slot0, liquidity, feeGrowth0, feeGrowth1] = await Promise.all([
                poolContract.slot0(),
                poolContract.liquidity(),
                poolContract.feeGrowthGlobal0X128(),
                poolContract.feeGrowthGlobal1X128()
            ]);

            const pool = new Pool(
                token0,
                token1,
                fee,
                slot0.sqrtPriceX96.toString(),
                liquidity.toString(),
                slot0.tick
            );

            return {
                address: poolAddress,
                token0: pool.token0.symbol,
                token1: pool.token1.symbol,
                fee: pool.fee,
                sqrtPriceX96: slot0.sqrtPriceX96.toString(),
                tick: slot0.tick,
                liquidity: liquidity.toString(),
                token0Price: pool.token0Price.toSignificant(6),
                token1Price: pool.token1Price.toSignificant(6)
            };

        } catch (error) {
            console.error('获取池子信息失败:', error);
            throw error;
        }
    }

    // 价格监控和自动交易
    async startPriceMonitoring(token0, token1, fee, targetPrice, action = 'buy', amount = 1) {
        console.log(`开始监控 ${token0.symbol}/${token1.symbol} 价格...`);
        console.log(`目标价格: ${targetPrice}, 动作: ${action}`);

        const checkPrice = async () => {
            try {
                const poolInfo = await this.getPoolInfo(token0, token1, fee);
                const currentPrice = parseFloat(poolInfo.token0Price);

                console.log(`当前价格: ${currentPrice.toFixed(6)}`);

                if (action === 'buy' && currentPrice <= targetPrice) {
                    console.log(`价格达到买入条件: ${currentPrice} <= ${targetPrice}`);
                    await this.swapTokens(token1, token0, amount);
                } else if (action === 'sell' && currentPrice >= targetPrice) {
                    console.log(`价格达到卖出条件: ${currentPrice} >= ${targetPrice}`);
                    await this.swapTokens(token0, token1, amount);
                }

            } catch (error) {
                console.error('价格检查失败:', error);
            }
        };

        // 每30秒检查一次价格
        setInterval(checkPrice, 30000);
        checkPrice(); // 立即执行一次
    }
}
