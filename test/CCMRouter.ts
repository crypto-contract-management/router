import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber, Signer } from "ethers";
import * as eths from "ethers";
import { formatEther } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import { PancakeFactory, PancakeFactory__factory, PancakePair, PancakePair__factory, PancakeRouter, PancakeRouterV2, PancakeRouterV2__factory, PancakeRouter__factory, CCMRouter, CCMRouter__factory, TestContract, MyWBNB, MyWBNB__factory, TCInBetweenSecond, TCInBetweenFirst, TCStackingSellTax } from "../typechain-types";
const { parseEther } = ethers.utils;

// Anything below 10 difference is sufficiently equal enough (rounding errors).
const numEq = (n1: BigNumber, n2: BigNumber) =>
    expect(n1.sub(n2).abs()).to.be.lte(BigNumber.from(10))

describe("CCM", () => {
    let owner: SignerWithAddress;
    let alice: SignerWithAddress;
    let bob: SignerWithAddress;
    let clarice: SignerWithAddress;
    let pairContract: PancakePair;
    let factoryContract: PancakeFactory;
    let pcsRouterContract: PancakeRouter;
    let routerContract: CCMRouter;
    let testContract: TestContract;
    let MyWBNBContract: MyWBNB;
    let pairFactory: PancakePair__factory;
    let factoryFactory: PancakeFactory__factory;
    let routerFactory: CCMRouter__factory;
    let pcsRouterFactory: PancakeRouter__factory;
    const ethAddress = "0x000000000000000000000000000000000000dEaD";

    beforeEach(async () => {
        pairFactory = await ethers.getContractFactory("PancakePair");
        factoryFactory = await ethers.getContractFactory("PancakeFactory");
        routerFactory = await ethers.getContractFactory("CCMRouter");
        pcsRouterFactory = await ethers.getContractFactory("PancakeRouter");
        [owner, alice, bob, clarice] = await ethers.getSigners();

        factoryContract = await factoryFactory.deploy(owner.address);
        pairContract = await pairFactory.deploy();
        MyWBNBContract = await (await ethers.getContractFactory("MyWBNB")).deploy();
        pcsRouterContract = await pcsRouterFactory.deploy(factoryContract.address, MyWBNBContract.address, {gasLimit: 20_000_000});
        routerContract = (await upgrades.deployProxy(routerFactory, [pcsRouterContract.address, MyWBNBContract.address], { kind: "uups"})) as CCMRouter;
    });

    describe("Factory", () => {
        it("Is correctly deployed", async() => {
            expect(await factoryContract.feeToSetter()).eq(owner.address);
        });
    });
    describe("Pair", () => {
        let pairAddress: string;
        let createdPair: PancakePair;
        beforeEach(async() => {
            pairAddress = (await factoryContract.callStatic.createPair("0x8F930c2c13d9d413a670892C2Acc38C3eb4A2951", "0xEa8B7E713f75F9FDb020756d3210613cd4Fe660d"));
            await factoryContract.createPair("0x8F930c2c13d9d413a670892C2Acc38C3eb4A2951", "0xEa8B7E713f75F9FDb020756d3210613cd4Fe660d")
            createdPair = await pairFactory.attach(pairAddress);
        });
        it("Is correctly deployed", async() => {
            expect(await createdPair.factory()).eq(factoryContract.address);
        });
    });
    
    let testMyWBNBPair: PancakePair;
    describe("Contract interactions", async() => {
        let routerByAlice: CCMRouter;
        beforeEach(async() => {
            // Prepare contract.
            testContract = await (await ethers.getContractFactory("TestContract")).deploy(routerContract.address);
            testContract.transfer(alice.address, parseEther("1000"));
            testContract.transfer(bob.address,  parseEther("1000"));
            // Deploy second contract for pairing. Let's take MyWBNB.
            
            MyWBNBContract.transfer(alice.address, parseEther("1000"));
            MyWBNBContract.transfer(bob.address,  parseEther("1000"));
            // Create pair.
            const pairAddress = (await factoryContract.callStatic.createPair(testContract.address, MyWBNBContract.address));
            await factoryContract.createPair(testContract.address, MyWBNBContract.address);
            testMyWBNBPair = await pairFactory.attach(pairAddress);
            await testContract.setIsPair(pairAddress, 1);
            // Provide liquidity.
            await testContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidityETH(
                testContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                owner.address, (await time.latest()) + 300,
                {value: parseEther("100")}
            );
            // Prepare alice.
            routerByAlice = await routerContract.connect(alice); 
            await approveTestContract(testContract, alice, routerByAlice.address);
            // Activate taxes
            await routerContract.claimInitialFeeOwnership(testContract.address);
            await routerContract.chooseTaxTierLevel(testContract.address);
        });
        
        it("Pair deployment successful", async() => {
            const firstToken = await testMyWBNBPair.token0();
            const secondToken = await testMyWBNBPair.token1();
            
            if(firstToken < secondToken){
                expect(await testMyWBNBPair.token0()).eq(firstToken);
                expect(await testMyWBNBPair.token1()).eq(secondToken);
            } else {
                expect(await testMyWBNBPair.token0()).eq(secondToken);
                expect(await testMyWBNBPair.token1()).eq(firstToken);
            }
        });

        it("Pay no fees as pair is uninitialized", async() => {
            // Alice tries to buy a token for 0% fee.
            let expectedToGet = (await pcsRouterContract.getAmountsOut(parseEther("0.99"), [MyWBNBContract.address, testContract.address]))[1];
            let balanceBefore = await testContract.balanceOf(alice.address);
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  (await time.latest()) + 30, 
                {value: parseEther("1")}
            );
            let balanceAfter = await testContract.balanceOf(alice.address);
            let tokensReceived = balanceAfter.sub(balanceBefore);
            expect(tokensReceived).to.be.eq(expectedToGet);
            // Alice tries to sell a token for 0% fee.
            await approveTestContract(testContract, alice, routerByAlice.address);
            // 1% subtracted for tax tier level.
            expectedToGet = parseEther("1.98");
            const tokensNeeded = (await pcsRouterContract.getAmountsIn(parseEther("2"), [testContract.address, MyWBNBContract.address]))[0];
            balanceBefore = await alice.getBalance();
            const secondTransaction = await routerByAlice.swapExactTokensForETH(
                tokensNeeded, 0, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            );
            balanceAfter = await alice.getBalance();
            const receipt = await secondTransaction.wait();
            const totalCost = receipt.gasUsed.mul(receipt.effectiveGasPrice);
            
            expectedToGet = expectedToGet.sub(totalCost);
            const bnbReceived = balanceAfter.sub(balanceBefore);
            expect(bnbReceived).to.be.eq(expectedToGet);
        });
    });
    
    describe("Test fee settings ownership", () => {
        let routerByAlice: CCMRouter;
        let routerByBob: CCMRouter;
        beforeEach(async() => {
            // Prepare contract.
            // Bob shall be the deployer of the contract now.
            const testContractFactory = await ethers.getContractFactory("TestContract");
            testContract = await testContractFactory.connect(bob).deploy(routerContract.address);
            testContract.transfer(alice.address, parseEther("1000"));
            testContract.transfer(clarice.address,  parseEther("1000"));
            // Deploy second contract for pairing. Let's take MyWBNB.
            
            MyWBNBContract.transfer(alice.address, parseEther("1000"));
            MyWBNBContract.transfer(bob.address,  parseEther("1000"));
            MyWBNBContract.transfer(clarice.address,  parseEther("1000"));
            // Create pair.
            const pairAddress = (await factoryContract.callStatic.createPair(testContract.address, MyWBNBContract.address));
            await factoryContract.createPair(testContract.address, MyWBNBContract.address);
            testMyWBNBPair = await pairFactory.attach(pairAddress);
            await testContract.setIsPair(pairAddress, 1);
            // Provide liquidity.
            await testContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            const bobsPcsRouterContract = await pcsRouterContract.connect(bob);
            await bobsPcsRouterContract.addLiquidityETH(
                testContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                bob.address, (await time.latest()) + 300,
                {value: parseEther("100")}
            );
            // Prepare alice.
            routerByAlice = await routerContract.connect(alice); 
            await approveTestContract(testContract, alice, routerByAlice.address);
            // Prepare bob.
            routerByBob = await routerContract.connect(bob); 
            await approveTestContract(testContract, bob, routerByBob.address);
        });

        describe("Initial fee ownership", () => {
            it("Claim by token owner", async() => {
                await routerByBob.claimInitialFeeOwnership(testContract.address);
                expect(await routerByBob.feeOwners(testContract.address)).eq(bob.address);
            });
            it("Claimable only once", async() => {
                await routerByBob.claimInitialFeeOwnership(testContract.address);
                await expect(routerByBob.claimInitialFeeOwnership(testContract.address)).to.be.revertedWith("CCM: FEE_OWNER_ALREADY_INITIALIZED");
            });
            it("Transfer fee ownership", async() => {
                await routerByBob.claimInitialFeeOwnership(testContract.address);
                await routerByBob.transferFeeOwnership(testContract.address, alice.address);
                expect(await routerByBob.feeOwners(testContract.address)).eq(alice.address);
                await routerByAlice.transferFeeOwnership(testContract.address, bob.address);
                expect(await routerByBob.feeOwners(testContract.address)).eq(bob.address);
            });
        })
    });
    describe("Router", () => {
        beforeEach(async() => {
            const testContractFactory = await ethers.getContractFactory("TestContract");
            testContract = await testContractFactory.deploy(routerContract.address);
            await routerContract.claimInitialFeeOwnership(testContract.address);
        });
        it("Is correctly deployed", async() => {
            expect(await routerContract.WETH()).eq(MyWBNBContract.address);
            expect(await pcsRouterContract.factory()).eq(factoryContract.address);
            expect(await pcsRouterContract.WETH()).eq(MyWBNBContract.address);
        });
    })
    describe("Test taxation", async() => {
        let routerByAlice: CCMRouter;
        beforeEach(async() => {
            // Prepare contract.
            testContract = await (await ethers.getContractFactory("TestContract")).deploy(routerContract.address);
            testContract.transfer(alice.address, parseEther("1000"));
            testContract.transfer(bob.address,  parseEther("1000"));
            // Deploy second contract for pairing. Let's take MyWBNB.
            
            MyWBNBContract.transfer(alice.address, parseEther("1000"));
            MyWBNBContract.transfer(bob.address,  parseEther("1000"));
            // Create pair.
            const pairAddress = (await factoryContract.callStatic.createPair(testContract.address, MyWBNBContract.address));
            await factoryContract.createPair(testContract.address, MyWBNBContract.address);
            testMyWBNBPair = await pairFactory.attach(pairAddress);
            await testContract.setIsPair(pairAddress, 1);
            // Provide liquidity.
            await testContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidityETH(
                testContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                owner.address, (await time.latest()) + 300,
                {value: parseEther("100")}
            );
            // Prepare alice.
            routerByAlice = await routerContract.connect(alice); 
            await approveTestContract(testContract, alice, routerByAlice.address);
            // Claim fee ownership.
            await routerContract.claimInitialFeeOwnership(testContract.address);
            // Activate taxes
            await routerContract.chooseTaxTierLevel(testContract.address);
        });
        it("5% buy 15% sell static, owner free, ETH=>TOKEN & TOKEN=>ETH", async() => {
            // Prepare contract.
            const testContract = await (await ethers.getContractFactory("TCFixedTaxes")).deploy(routerContract.address);
            testContract.transfer(alice.address, parseEther("1000"));
            testContract.transfer(bob.address,  parseEther("1000"));
            // Create pair.
            const pairAddress = (await factoryContract.callStatic.createPair(testContract.address, MyWBNBContract.address));
            await factoryContract.createPair(testContract.address, MyWBNBContract.address);
            testMyWBNBPair = await pairFactory.attach(pairAddress);
            await testContract.setIsPair(pairAddress, 1);
            // Provide liquidity.
            await testContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidityETH(
                testContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                owner.address, (await time.latest()) + 300,
                {value: parseEther("100")}
            );
            // Prepare alice.
            routerByAlice = await routerContract.connect(alice); 
            (await (await testContract.connect(alice)).approve(routerByAlice.address, ethers.constants.MaxUint256))
            // Claim fee ownership.
            await routerContract.claimInitialFeeOwnership(testContract.address);
            // Activate taxes
            await routerContract.chooseTaxTierLevel(testContract.address);
            
            // Alice tries to swap some tokens
            const aliceTCBeforeBuy = await testContract.balanceOf(alice.address);
            const contractBalanceBefore = await testContract.provider.getBalance(testContract.address);
            // Buy 3 times => 3 times 6% fee to pay.
            let expectedTCToGet = (await pcsRouterContract.getAmountsOut(parseEther("0.94"), [MyWBNBContract.address, testContract.address]))[1];
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  (await time.latest()) + 30, 
                {value: parseEther("1")}
            );
            const tokensForThisTrade = (await pcsRouterContract.getAmountsOut(parseEther("0.94"), [MyWBNBContract.address, testContract.address]))[1]
            expectedTCToGet = expectedTCToGet.add(tokensForThisTrade);
            await routerByAlice.swapETHForExactTokens(
                tokensForThisTrade, [MyWBNBContract.address, testContract.address], 
                alice.address,  (await time.latest()) + 30, 
                {value: parseEther("1")}
            );
            expectedTCToGet = expectedTCToGet.add((await pcsRouterContract.getAmountsOut(parseEther("0.94"), [MyWBNBContract.address, testContract.address]))[1]);
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  (await time.latest()) + 30, 
                {value: parseEther("1")}
            );
            const aliceTCGained = (await testContract.balanceOf(alice.address)).sub(aliceTCBeforeBuy);
            expect(aliceTCGained).to.be.eq(expectedTCToGet);
            // Sell the earned amount twice for 15% token tax, 1% tax tier level => 16% tax each.
            const tcToSell = aliceTCGained.div(2);
            const aliceWbnbBeforeSell = await alice.getBalance();
            let expectedWBNBToGet = (await pcsRouterContract.getAmountsOut(tcToSell, [testContract.address, MyWBNBContract.address]))[1];
            
            const txn1 = await (await routerByAlice.swapExactTokensForETH(
                tcToSell, 0,
                [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30, 
            )).wait();
            expectedWBNBToGet = expectedWBNBToGet.add(parseEther("1"));
            const txn2 = await(await routerByAlice.swapTokensForExactETH(
                parseEther("1"), parseEther("10"),
                [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30, 
            )).wait();
            // Final expecetd wbnb is 84% of that value. Minus txn costs.
            const txnCosts = txn1.gasUsed.mul(txn1.effectiveGasPrice).add(txn2.gasUsed.mul(txn2.effectiveGasPrice));
            const aliceEthGained = (await alice.getBalance()).sub(aliceWbnbBeforeSell);
            numEq(aliceEthGained, expectedWBNBToGet.mul(84).div(100).sub(txnCosts));
            // The owner itself should not pay any fees.
            // When they buy or sell the only thing getting subtracted is the 1% of the tax tier.
            const ownerExpectedTCToGet = (await pcsRouterContract.getAmountsOut(parseEther("0.99"), [MyWBNBContract.address, testContract.address]))[1];
            const ownerTCBeforeBuy = await testContract.balanceOf(owner.address);
            await routerContract.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                owner.address,  (await time.latest()) + 30, 
                {value: parseEther("1")}
            );
            const ownerTCGained = (await testContract.balanceOf(owner.address)).sub(ownerTCBeforeBuy);
            numEq(ownerExpectedTCToGet, ownerTCGained);
            const ownerExpectedEthToGet = ((await pcsRouterContract.getAmountsOut(parseEther("1"), [testContract.address, MyWBNBContract.address]))[1]).mul(99).div(100);
            await testContract.approve(routerContract.address, ethers.constants.MaxUint256);
            const ownerEthBeforeSell = await owner.getBalance();
            const ownerTxn = await(await routerContract.swapExactTokensForETH(
                parseEther("1"), 0, [testContract.address, MyWBNBContract.address], 
                owner.address,  (await time.latest()) + 30
            )).wait();
            const ownerEthGained = (await owner.getBalance()).sub(ownerEthBeforeSell);
            const ownerTxnCost = ownerTxn.gasUsed.mul(ownerTxn.effectiveGasPrice);
            numEq(ownerEthGained, ownerExpectedEthToGet.sub(ownerTxnCost));
            // The contract should have earned both buy and sell taxes.
            const sellTaxesEarnedByContract = expectedWBNBToGet.mul(15).div(100);
            const contractEthGained = (await testContract.provider.getBalance(testContract.address))
                .sub(contractBalanceBefore);
            expect(contractEthGained).to.be.eq(parseEther("0.15").add(sellTaxesEarnedByContract));
        });
    });
    
    describe("Test in-between token tax transfers (WETH taxes)", async() => {
        let routerByAlice: CCMRouter;
        let routerByBob: CCMRouter;
        let testContract: TCInBetweenFirst;
        let testContract2: TCInBetweenSecond;
        beforeEach(async() => {
            // Prepare contract.
            testContract = await (await ethers.getContractFactory("TCInBetweenFirst")).deploy(routerContract.address);
            testContract.transfer(alice.address, parseEther("1000"));
            testContract.transfer(bob.address,  parseEther("1000"));
            // Deploy second contract for pairing. Let's take MyWBNB.
            
            MyWBNBContract.transfer(alice.address, parseEther("1000"));
            MyWBNBContract.transfer(bob.address,  parseEther("1000"));
            // Create pair.
            const pairAddress = (await factoryContract.callStatic.createPair(testContract.address, MyWBNBContract.address));
            await factoryContract.createPair(testContract.address, MyWBNBContract.address);
            testMyWBNBPair = await pairFactory.attach(pairAddress);
            await testContract.setIsPair(pairAddress, 1);
            // Provide liquidity.
            await testContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidityETH(
                testContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                owner.address, (await time.latest()) + 300,
                {value: parseEther("100")}
            );
            // Prepare alice.
            routerByAlice = await routerContract.connect(alice); 
            await approveTestContract(testContract, alice, routerByAlice.address);
            // Prepare bob
            routerByBob = await routerContract.connect(bob);
            await approveTestContract(testContract, bob, routerByBob.address);
            // Activate taxes
            await routerContract.claimInitialFeeOwnership(testContract.address);
            await routerContract.chooseTaxTierLevel(testContract.address);
            
            // Deploy another token to swap for.
            // Path is: TestContract1 => MyWBNB => TestContract 2
            testContract2 = await (await ethers.getContractFactory("TCInBetweenSecond")).deploy(routerContract.address);
            testContract2.transfer(alice.address, parseEther("1000"));
            testContract2.transfer(bob.address,  parseEther("1000"));
            // Create pair.
            const testContract2MyWBNBPair = (await factoryContract.callStatic.createPair(testContract2.address, MyWBNBContract.address));
            await factoryContract.createPair(testContract2.address, MyWBNBContract.address);
            testMyWBNBPair = await pairFactory.attach(testContract2MyWBNBPair);
            await testContract2.setIsPair(testContract2MyWBNBPair, 1);
            // Provide liquidity.
            await testContract2.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidityETH(
                testContract2.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                owner.address, (await time.latest()) + 300,
                {value: parseEther("100")}
            );
            // Prepare alice.
            await approveTestContract(testContract2, alice, routerByAlice.address);
            // Prepare bob
            await approveTestContract(testContract2, bob, routerByBob.address);
            // Now we can declare the fees:
            // 1: 22.27% OUT (someone is giving tokens in and taking WETH OUT of the pool) for test contract 1
            // 2: 50% IN (someone is giving WETH IN to the pool) for test contract 2
            // The other fees (IN for test contract 1 and OUT for test contract 2) can be arbitrarily chosen
            // to make sure only the respective IN/OUT fees are taken. So they should just be greater than 0.
            // Set taxes
            await routerContract.claimInitialFeeOwnership(testContract2.address);
            await routerContract.chooseTaxTierLevel(testContract2.address);
        });
        it("First contract sells for 69.69% and buys for 22.27%, second one sells for 25% and buys 10% (WETH)", async() => {
            // Alice buys second token for first token once and buys first token for second token once:
            // 1. Sells 10 ETH worth of token 1 to buy token 2. => First: 6.969 - Second: 0.2931 WETH fee.
            // 2. Sells 20 ETH worth of token 2 to buy token 1 => Second: 5 - First: 3.29596 WETH fee.
            // First total: 10.26496 WETH.
            // Second total: 5.2931 WETH.
            const tcFirstContractWethGainedExpected = parseEther("10.26496");
            const tcSecondContractWethGainedExpected = parseEther("5.2931");
            const tcFirstContractWethBefore = await MyWBNBContract.balanceOf(testContract.address);
            const tcSecondContractWethBefore = await MyWBNBContract.balanceOf(testContract2.address);
            const tcFirstRequiredForSell = (await pcsRouterContract.getAmountsIn(
                parseEther("10"), [testContract.address, MyWBNBContract.address]
            ))[0];
            // Alice: Sell tc first to buy tc second!
            await routerByAlice.swapExactTokensForTokens(
                tcFirstRequiredForSell, 0,
                [testContract.address, MyWBNBContract.address, testContract2.address],
                alice.address, (await time.latest()) + 30
            );
            // Fine. Now sell tokens worth of 20 eth of tc second to get tc first.
            const tcSecondRequiredForSell = (await pcsRouterContract.getAmountsIn(
                parseEther("20"), [testContract2.address, MyWBNBContract.address]
            ))[0];
            // Alice: Sell tc second to buy tc first!
            await routerByAlice.swapExactTokensForTokens(
                tcSecondRequiredForSell, 0,
                [testContract2.address, MyWBNBContract.address, testContract.address],
                alice.address, (await time.latest()) + 30
            );
            const tcFirstContractWethAfter = await MyWBNBContract.balanceOf(testContract.address);
            const tcSecondContractWethAfter = await MyWBNBContract.balanceOf(testContract2.address);
            const tcFirstContractWethGained = tcFirstContractWethAfter.sub(tcFirstContractWethBefore);
            const tcSecondContractWethGained = tcSecondContractWethAfter.sub(tcSecondContractWethBefore);
            expect(tcFirstContractWethGained).to.eq(tcFirstContractWethGainedExpected);
            expect(tcSecondContractWethGained).to.eq(tcSecondContractWethGainedExpected);
        });
        it("Contract sells stack for 10% for each sell, reset on buy. Check if bob gets all the fees", async() => {
            const tcStackingSellContract = await (await ethers.getContractFactory("TCStackingSellTax")).deploy(routerContract.address, bob.address);
            tcStackingSellContract.transfer(alice.address, parseEther("1000"));
            tcStackingSellContract.transfer(bob.address,  parseEther("1000"));
            // Create pair.
            const tcStackingSellContractMyWBNBPair = (await factoryContract.callStatic.createPair(tcStackingSellContract.address, MyWBNBContract.address));
            await factoryContract.createPair(tcStackingSellContract.address, MyWBNBContract.address);
            await tcStackingSellContract.setIsPair(tcStackingSellContractMyWBNBPair, 1);
            // Provide liquidity.
            await tcStackingSellContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await MyWBNBContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidity(
                tcStackingSellContract.address,
                MyWBNBContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"), parseEther("100"),
                owner.address, (await time.latest()) + 300,
            );
            // Prepare alice.
            await approveTestContract(tcStackingSellContract, alice, routerByAlice.address);
            // Prepare bob
            await approveTestContract(tcStackingSellContract, bob, routerByBob.address);
            // Init tax system.
            await routerContract.claimInitialFeeOwnership(tcStackingSellContract.address);
            await routerContract.chooseTaxTierLevel(tcStackingSellContract.address);
            // Now let alice trade and bob receive the fees:
            // 1. One sell for 10 WETH => 1 WETH fee.
            // 2. One sell for 15 WETH => 3 WETH fee.
            // 3. One sell for 10 WETH => 3 WETH fee.
            // 4. One buy for 25 WETH => 0 WETH fee.
            // 5. One sell for 5 WETH => 0.5 WETH fee.
            // Total fees earned: 7.5 WETH.
            const bobWethGainedExpected = parseEther("7.5");
            const bobWethBefore = await MyWBNBContract.balanceOf(bob.address);
            let tokensNeededForSell = (await pcsRouterContract.getAmountsIn(
                parseEther("10"), [tcStackingSellContract.address, MyWBNBContract.address]
            ))[0];
            await routerByAlice.swapExactTokensForTokens(
                tokensNeededForSell, 0,
                [tcStackingSellContract.address, MyWBNBContract.address],
                alice.address, (await time.latest()) + 30
            );
            tokensNeededForSell = (await pcsRouterContract.getAmountsIn(
                parseEther("15"), [tcStackingSellContract.address, MyWBNBContract.address]
            ))[0];
            await routerByAlice.swapExactTokensForTokens(
                tokensNeededForSell, 0,
                [tcStackingSellContract.address, MyWBNBContract.address],
                alice.address, (await time.latest()) + 30
            );
            tokensNeededForSell = (await pcsRouterContract.getAmountsIn(
                parseEther("10"), [tcStackingSellContract.address, MyWBNBContract.address]
            ))[0];
            await routerByAlice.swapExactTokensForTokens(
                tokensNeededForSell, 0,
                [tcStackingSellContract.address, MyWBNBContract.address],
                alice.address, (await time.latest()) + 30
            );
            const tokensNeededForBuy = parseEther("10");
            await approveMyWBNBContract(MyWBNBContract, alice, routerByAlice.address);
            await routerByAlice.swapExactTokensForTokens(
                tokensNeededForBuy, 0,
                [MyWBNBContract.address, tcStackingSellContract.address],
                alice.address, (await time.latest()) + 30
            );
            tokensNeededForSell = (await pcsRouterContract.getAmountsIn(
                parseEther("5"), [tcStackingSellContract.address, MyWBNBContract.address]
            ))[0];
            await routerByAlice.swapExactTokensForTokens(
                tokensNeededForSell, 0,
                [tcStackingSellContract.address, MyWBNBContract.address],
                alice.address, (await time.latest()) + 30
            );
            const bobWethAfter = await MyWBNBContract.balanceOf(bob.address);
            const bobWethGained = bobWethAfter.sub(bobWethBefore);
            expect(bobWethGained).to.eq(bobWethGainedExpected);
        })
    });
    return;/*
    describe("Test tax tier levels", async() => {
        let routerByAlice: CCMRouter;
        let routerByBob: CCMRouter;
        beforeEach(async() => {
            // Prepare contract.
            testContract = await (await ethers.getContractFactory("TestContract")).deploy(routerContract.address);
            testContract.transfer(alice.address, parseEther("1000"));
            testContract.transfer(bob.address,  parseEther("1000"));
            // Deploy second contract for pairing. Let's take MyWBNB.
            
            MyWBNBContract.transfer(alice.address, parseEther("1000"));
            MyWBNBContract.transfer(bob.address,  parseEther("1000"));
            // Create pair.
            const pairAddress = (await factoryContract.callStatic.createPair(testContract.address, MyWBNBContract.address));
            await factoryContract.createPair(testContract.address, MyWBNBContract.address);
            testMyWBNBPair = await pairFactory.attach(pairAddress);
            await testContract.setIsPair(pairAddress, 1);
            // Provide liquidity.
            await testContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidityETH(
                testContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                owner.address, (await time.latest()) + 300,
                {value: parseEther("100")}
            );
            // Prepare alice.
            routerByAlice = await routerContract.connect(alice); 
            await approveTestContract(testContract, alice, routerByAlice.address);
            // Prepare bob
            routerByBob = await routerContract.connect(bob);
            await approveTestContract(testContract, bob, routerByBob.address);
            // Activate taxes
            await routerContract.claimInitialFeeOwnership(testContract.address);
            
        });
        it("Only accept the exact ETH sent in to choose a tier level", async() => {
            // For apprentice we require exactly 5 bnb.
            await expect(routerContract.chooseTaxTierLevel(testContract.address, {value: parseEther("4.9999999999")})).to.be.revertedWith("CCM: NO_TIER_LEVEL_SELECTED");
            await expect(routerContract.chooseTaxTierLevel(testContract.address, {value: parseEther("5.0000000001")})).to.be.revertedWith("CCM: NO_TIER_LEVEL_SELECTED");
            await expect(routerContract.chooseTaxTierLevel(testContract.address, {value: parseEther("3")})).to.be.revertedWith("CCM: NO_TIER_LEVEL_SELECTED");
            // For expert we require exactly 10 bnb.
            await expect(routerContract.chooseTaxTierLevel(testContract.address, {value: parseEther("9.9999999999")})).to.be.revertedWith("CCM: NO_TIER_LEVEL_SELECTED");
            await expect(routerContract.chooseTaxTierLevel(testContract.address, {value: parseEther("10.0000000001")})).to.be.revertedWith("CCM: NO_TIER_LEVEL_SELECTED");
            await expect(routerContract.chooseTaxTierLevel(testContract.address, {value: parseEther("8")})).to.be.revertedWith("CCM: NO_TIER_LEVEL_SELECTED");
        })
        it("Tax tier level apprentice", async() => {
            await routerContract.chooseTaxTierLevel(testContract.address, {value: parseEther("0.5")});
            // Just buy and sell as above.
            // Total of buys/sells is 100 bnb, with apprentice (0.5% tax) This makes 0.5 bnb for us/the router.
            const contractBalanceBefore = await routerContract.provider.getBalance(routerContract.address);
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  (await time.latest()) + 30, 
                {value: parseEther("10")}
            );
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  (await time.latest()) + 30, 
                {value: parseEther("25")}
            );
            await routerByBob.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  (await time.latest()) + 30, 
                {value: parseEther("22")}
            );
            // Then Alice sells three times and bob four times for a total of 43 bnb.
            await routerByAlice.swapTokensForExactETH(
                parseEther("8"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            );
            await routerByAlice.swapTokensForExactETH(
                parseEther("7"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            );
            await routerByAlice.swapTokensForExactETH(
                parseEther("7"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            );
            await routerByBob.swapTokensForExactETH(
                parseEther("6"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            );
            await routerByBob.swapTokensForExactETH(
                parseEther("5"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            );
            await routerByBob.swapTokensForExactETH(
                parseEther("5"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            );
            await routerByBob.swapTokensForExactETH(
                parseEther("5"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            );
            const contractBalanceAfter = await routerContract.provider.getBalance(routerContract.address);
            // This is what the contract really earned.
            const contractETHEarned = contractBalanceAfter.sub(contractBalanceBefore);
            // This is what the contract itself tracked it should have earned.
            // Those two have to match of course. And both need to tell 0.5 bnb.
            const contractETHTaxReceived = await routerContract.routerTaxesEarned(ethAddress);
            const expectedETHEarned = parseEther("0.5");
            const expectedETHTaxEarned = parseEther("1.0");

            expect(contractETHEarned).eq(expectedETHEarned);
            expect(contractETHTaxReceived).eq(expectedETHTaxEarned);
        });
        it("Tax tier level expert", async() => {
            await routerContract.chooseTaxTierLevel(testContract.address, {value: parseEther("1")});
            // Just buy and sell as above.
            // Total of buys/sells is 100 bnb, with apprentice (0.3% tax) This makes 0.3 bnb for us/the router.
            const contractBalanceBefore = await routerContract.provider.getBalance(routerContract.address);
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  (await time.latest()) + 30, 
                {value: parseEther("10")}
            );
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  (await time.latest()) + 30, 
                {value: parseEther("25")}
            );
            await routerByBob.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  (await time.latest()) + 30, 
                {value: parseEther("22")}
            );
            // Then Alice sells three times and bob four times for a total of 43 bnb.
            await routerByAlice.swapTokensForExactETH(
                parseEther("8"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            );
            await routerByAlice.swapTokensForExactETH(
                parseEther("7"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            );
            await routerByAlice.swapTokensForExactETH(
                parseEther("7"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            );
            await routerByBob.swapTokensForExactETH(
                parseEther("6"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            );
            await routerByBob.swapTokensForExactETH(
                parseEther("5"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            );
            await routerByBob.swapTokensForExactETH(
                parseEther("5"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            );
            await routerByBob.swapTokensForExactETH(
                parseEther("5"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            );
            const contractBalanceAfter = await routerContract.provider.getBalance(routerContract.address);
            // This is what the contract really earned.
            const contractETHEarned = contractBalanceAfter.sub(contractBalanceBefore);
            // This is what the contract itself tracked it should have earned.
            // Those two have to match of course. And both need to tell 0.3 bnb.
            const contractETHTaxReceived = await routerContract.routerTaxesEarned(ethAddress);
            const expectedETHEarned = parseEther("0.3");
            const expectedETHTaxEarned = parseEther("1.3");

            expect(contractETHEarned).eq(expectedETHEarned);
            expect(contractETHTaxReceived).eq(expectedETHTaxEarned);
        });
    });
    describe("Set tax tier manually by owner", async() => {
        let routerByAlice: CCMRouter;
        let routerByBob: CCMRouter;
        beforeEach(async() => {
            // Prepare contract.
            testContract = await (await ethers.getContractFactory("TestContract")).deploy(routerContract.address);
            testContract.transfer(alice.address, parseEther("1000"));
            testContract.transfer(bob.address,  parseEther("1000"));
            // Deploy second contract for pairing. Let's take MyWBNB.
            
            MyWBNBContract.transfer(alice.address, parseEther("1000"));
            MyWBNBContract.transfer(bob.address,  parseEther("1000"));
            // Create pair.
            const pairAddress = (await factoryContract.callStatic.createPair(testContract.address, MyWBNBContract.address));
            await factoryContract.createPair(testContract.address, MyWBNBContract.address);
            testMyWBNBPair = await pairFactory.attach(pairAddress);
            await testContract.setIsPair(pairAddress, 1);
            // Provide liquidity.
            await testContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidityETH(
                testContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                owner.address, (await time.latest()) + 300,
                {value: parseEther("100")}
            );
            // Prepare alice.
            routerByAlice = await routerContract.connect(alice); 
            await approveTestContract(testContract, alice, routerByAlice.address);
            // Prepare bob
            routerByBob = await routerContract.connect(bob);
            await approveTestContract(testContract, bob, routerByBob.address);
            // Activate taxes
            await routerContract.claimInitialFeeOwnership(testContract.address);
        });
        it("Set for uninitialized pair", async() => {
            await routerContract.setTaxTierLevel(testContract.address, 69);
            const baseTaxEntry = await routerContract.tokenBaseTax(testContract.address);
            expect(baseTaxEntry).to.deep.equal([true, 69]);
        });
        it("Set for initialized pair", async() => {
            await routerContract.chooseTaxTierLevel(testContract.address);
            await routerContract.setTaxTierLevel(testContract.address, 42);
            const baseTaxEntry = await routerContract.tokenBaseTax(testContract.address);
            expect(baseTaxEntry).to.deep.equal([true, 42]);
        });
        it("Max fee of 1%", async() => {
            await expect(routerContract.setTaxTierLevel(testContract.address, 101)).to.be.revertedWith("CCM: SET_TAX_TIER_LEVEL_INVALID_TAX");
        });
        it("Updated fee must be better than before", async() => {
            await routerContract.chooseTaxTierLevel(testContract.address);
            await routerContract.setTaxTierLevel(testContract.address, 42);
            await expect(routerContract.setTaxTierLevel(testContract.address, 69)).to.be.revertedWith("CCM: SET_TAX_TIER_LEVEL_INVALID_TAX_UPDATE");
        });
        it("Only owner", async() => {
            await expect(routerByAlice.setTaxTierLevel(testContract.address, 30)).to.be.revertedWith("Ownable: caller is not the owner");
        });
    });
    describe("Auto claim taxes", async() => {
        let routerByAlice: CCMRouter;
        let routerByBob: CCMRouter;
        beforeEach(async() => {
            // Prepare contract.
            testContract = await (await (await ethers.getContractFactory("TestContract")).connect(bob)).deploy(routerContract.address);
            testContract.transfer(alice.address, parseEther("1000"));
            testContract.transfer(owner.address,  parseEther("1000"));
            // Deploy second contract for pairing. Let's take MyWBNB.
            
            MyWBNBContract.transfer(alice.address, parseEther("1000"));
            MyWBNBContract.transfer(bob.address,  parseEther("1000"));
            // Create pair.
            const pairAddress = (await factoryContract.callStatic.createPair(testContract.address, MyWBNBContract.address));
            await factoryContract.createPair(testContract.address, MyWBNBContract.address);
            testMyWBNBPair = await pairFactory.attach(pairAddress);
            await testContract.setIsPair(pairAddress, 1);
            // Provide liquidity.
            await testContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await (await testContract.connect(owner)).approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await (await pcsRouterContract.connect(bob)).addLiquidityETH(
                testContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                bob.address, (await time.latest()) + 300,
                {value: parseEther("100")}
            );
            // Prepare alice.
            routerByAlice = await routerContract.connect(alice); 
            await approveTestContract(testContract, alice, routerByAlice.address);
            // Prepare bob
            routerByBob = await routerContract.connect(bob);
            await approveTestContract(testContract, bob, routerByBob.address);
            // Activate taxes
            await routerByBob.claimInitialFeeOwnership(testContract.address);
            await routerContract.setTaxTierLevel(testContract.address, 0);
        });
        it("Clarice auto claims every trade, 5 trades in total executed", async() => {
            // Tax prepare
            await routerByBob.setTaxes(testContract.address, ethAddress, 1500, 500,clarice.address);
            await routerByBob.setAutoClaimTaxes(testContract.address, ethAddress, 1);
            // Save receiver balance
            const clariceBefore = await clarice.getBalance();
            // Execute buys and sells.
            // Alice buy
            const aliceBefore = await testContract.balanceOf(alice.address);
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], alice.address, (await time.latest()) + 300,
                { value: parseEther("5")}
            );
            const aliceAfterOne = await testContract.balanceOf(alice.address);
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], alice.address, (await time.latest()) + 300,
                { value: parseEther("5")}
            );
            const aliceAfterTwo = await testContract.balanceOf(alice.address);
            // Bob buy
            const bobBefore = await testContract.balanceOf(bob.address);
            await routerByBob.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], bob.address, (await time.latest()) + 300,
                { value: parseEther("5")}
            );
            const bobAfter = await testContract.balanceOf(bob.address);
            const bobPurchasedTokens = bobAfter.sub(bobBefore);
            const bobETHFromSell = (await pcsRouterContract.getAmountsOut(bobPurchasedTokens, [testContract.address, MyWBNBContract.address]))[1];
            const ethFeeFromBobSell = bobETHFromSell.mul(1500).div(10000);
            // Bob sell
            await routerByBob.swapExactTokensForETH(
                bobPurchasedTokens, 0, [testContract.address, MyWBNBContract.address], bob.address, (await time.latest()) + 300
            );
            const alicePurchasedTokens = aliceAfterTwo.sub(aliceAfterOne);
            const aliceETHFromSell = (await pcsRouterContract.getAmountsOut(alicePurchasedTokens, [testContract.address, MyWBNBContract.address]))[1];
            const ethFeeFromAliceSell = aliceETHFromSell.mul(1500).div(10000);
            // Alice sell
            await routerByAlice.swapExactTokensForETH(
                aliceAfterTwo.sub(aliceAfterOne), 0, [testContract.address, MyWBNBContract.address], alice.address, (await time.latest()) + 300
            );
            
            const clariceAfter = await clarice.getBalance();
            const gainedBalance = clariceAfter.sub(clariceBefore);
            const expectedTaxes = parseEther("0.75").add(ethFeeFromBobSell).add(ethFeeFromAliceSell);
            expect(gainedBalance).eq(expectedTaxes);
            // There should not be any pending taxes.
            const pendingClaimableTaxes = await routerByAlice.tokenTotalTaxes(testContract.address, ethAddress);
            const expectedClaimableTaxes = [BigNumber.from(0), BigNumber.from(0)];
            expect(pendingClaimableTaxes.slice(2, 4)).to.to.deep.equal(expectedClaimableTaxes);
        });
        it("Clarice auto claims every 2nd trade, 5 trades in total executed", async() => {
            // Tax prepare
            await routerByBob.setTaxes(testContract.address, ethAddress, 1500, 500,clarice.address);
            await routerByBob.setAutoClaimTaxes(testContract.address, ethAddress, 2);
            // Save receiver balance
            const clariceBefore = await clarice.getBalance();
            // Execute buys and sells.
            // Alice buy
            const aliceBefore = await testContract.balanceOf(alice.address);
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], alice.address, (await time.latest()) + 300,
                { value: parseEther("5")}
            );
            const aliceAfterOne = await testContract.balanceOf(alice.address);
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], alice.address, (await time.latest()) + 300,
                { value: parseEther("5")}
            );
            const aliceAfterTwo = await testContract.balanceOf(alice.address);
            // Bob buy
            const bobBefore = await testContract.balanceOf(bob.address);
            await routerByBob.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], bob.address, (await time.latest()) + 300,
                { value: parseEther("5")}
            );
            const bobAfter = await testContract.balanceOf(bob.address);
            const bobPurchasedTokens = bobAfter.sub(bobBefore);
            const bobETHFromSell = (await pcsRouterContract.getAmountsOut(bobPurchasedTokens, [testContract.address, MyWBNBContract.address]))[1];
            const ethFeeFromBobSell = bobETHFromSell.mul(1500).div(10000);
            // Bob sell
            await routerByBob.swapExactTokensForETH(
                bobPurchasedTokens, 0, [testContract.address, MyWBNBContract.address], bob.address, (await time.latest()) + 300
            );
            const alicePurchasedTokens = aliceAfterTwo.sub(aliceAfterOne);
            const aliceETHFromSell = (await pcsRouterContract.getAmountsOut(alicePurchasedTokens, [testContract.address, MyWBNBContract.address]))[1];
            const ethFeeFromAliceSell = aliceETHFromSell.mul(1500).div(10000);
            // Alice sell
            await routerByAlice.swapExactTokensForETH(
                aliceAfterTwo.sub(aliceAfterOne), 0, [testContract.address, MyWBNBContract.address], alice.address, (await time.latest()) + 300
            );
            
            const clariceAfter = await clarice.getBalance();
            const gainedBalance = clariceAfter.sub(clariceBefore);
            const expectedTaxes = parseEther("0.75").add(ethFeeFromBobSell);
            expect(gainedBalance).eq(expectedTaxes);
            // There should still be pending taxes.
            const pendingClaimableTaxes = await routerByAlice.tokenTotalTaxes(testContract.address, ethAddress);
            const expectedClaimableTaxes = [ethFeeFromAliceSell, BigNumber.from(0)];
            expect(pendingClaimableTaxes.slice(2, 4)).to.to.deep.equal(expectedClaimableTaxes);
        });
        it("Clarice auto claims every 3rd trade, 5 trades in total executed", async() => {
            // Tax prepare
            await routerByBob.setTaxes(testContract.address, ethAddress, 1500, 500,clarice.address);
            await routerByBob.setAutoClaimTaxes(testContract.address, ethAddress, 3);
            // Save receiver balance
            const clariceBefore = await clarice.getBalance();
            // Execute buys and sells.
            // Alice buy
            const aliceBefore = await testContract.balanceOf(alice.address);
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], alice.address, (await time.latest()) + 300,
                { value: parseEther("5")}
            );
            const aliceAfterOne = await testContract.balanceOf(alice.address);
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], alice.address, (await time.latest()) + 300,
                { value: parseEther("5")}
            );
            const aliceAfterTwo = await testContract.balanceOf(alice.address);
            // Bob buy
            const bobBefore = await testContract.balanceOf(bob.address);
            await routerByBob.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], bob.address, (await time.latest()) + 300,
                { value: parseEther("5")}
            );
            const bobAfter = await testContract.balanceOf(bob.address);
            const bobPurchasedTokens = bobAfter.sub(bobBefore);
            const bobETHFromSell = (await pcsRouterContract.getAmountsOut(bobPurchasedTokens, [testContract.address, MyWBNBContract.address]))[1];
            const ethFeeFromBobSell = bobETHFromSell.mul(1500).div(10000);
            // Bob sell
            await routerByBob.swapExactTokensForETH(
                bobPurchasedTokens, 0, [testContract.address, MyWBNBContract.address], bob.address, (await time.latest()) + 300
            );
            const alicePurchasedTokens = aliceAfterTwo.sub(aliceAfterOne);
            const aliceETHFromSell = (await pcsRouterContract.getAmountsOut(alicePurchasedTokens, [testContract.address, MyWBNBContract.address]))[1];
            const ethFeeFromAliceSell = aliceETHFromSell.mul(1500).div(10000);
            // Alice sell
            await routerByAlice.swapExactTokensForETH(
                aliceAfterTwo.sub(aliceAfterOne), 0, [testContract.address, MyWBNBContract.address], alice.address, (await time.latest()) + 300
            );
            
            const clariceAfter = await clarice.getBalance();
            const gainedBalance = clariceAfter.sub(clariceBefore);
            const expectedTaxes = parseEther("0.75");
            expect(gainedBalance).eq(expectedTaxes);
            // There should still be pending taxes.
            const pendingClaimableTaxes = await routerByAlice.tokenTotalTaxes(testContract.address, ethAddress);
            const expectedClaimableTaxes = [ethFeeFromAliceSell.add(ethFeeFromBobSell), BigNumber.from(0)];
            expect(pendingClaimableTaxes.slice(2, 4)).to.to.deep.equal(expectedClaimableTaxes);
        });
    });
    describe("Update contract to V2 and check if logic applied", async() => {
        let routerByAlice: CCMRouter;
        let routerByBob: CCMRouter;
        beforeEach(async() => {
            // Prepare contract.
            testContract = await (await ethers.getContractFactory("TestContract")).deploy(routerContract.address);
            testContract.transfer(alice.address, parseEther("1000"));
            testContract.transfer(bob.address,  parseEther("1000"));
            // Deploy second contract for pairing. Let's take MyWBNB.
            
            MyWBNBContract.transfer(alice.address, parseEther("1000"));
            MyWBNBContract.transfer(bob.address,  parseEther("1000"));
            // Create pair.
            const pairAddress = (await factoryContract.callStatic.createPair(testContract.address, MyWBNBContract.address));
            await factoryContract.createPair(testContract.address, MyWBNBContract.address);
            testMyWBNBPair = await pairFactory.attach(pairAddress);
            await testContract.setIsPair(pairAddress, 1);
            // Provide liquidity.
            await testContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidityETH(
                testContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                owner.address, (await time.latest()) + 300,
                {value: parseEther("100")}
            );
            // Prepare alice.
            routerByAlice = await routerContract.connect(alice); 
            await approveTestContract(testContract, alice, routerByAlice.address);
            // Prepare bob
            routerByBob = await routerContract.connect(bob);
            await approveTestContract(testContract, bob, routerByBob.address);
            // Activate new proxy contract
            const routerV2Factory = await ethers.getContractFactory("CCMRouterV2");
            routerContract = await upgrades.upgradeProxy(routerContract.address, routerV2Factory, {kind: "uups"}) as CCMRouter;
            // Activate taxes
            await routerContract.claimInitialFeeOwnership(testContract.address);
            await routerContract.chooseTaxTierLevel(testContract.address);
        });
        it("swapExactETHForTokens", async() => {
            // Set taxes
            await routerContract.setTaxes(testContract.address, ethAddress, 0, 2000, owner.address);
            // Alice tries to swap some tokens
            const balanceBefore = await testContract.balanceOf(alice.address);
            // Subtract another 1% for the tax tier level: 0.8 - 0.01 => 0.79.
            // RouterV2: Plain 1 eth less.
            const ethSentIn = parseEther("5");
            const ethSentInAfterFees = ethSentIn.mul(79).div(100).sub(parseEther("1"));
            const expectedToGet = (await pcsRouterContract.getAmountsOut(ethSentInAfterFees, [MyWBNBContract.address, testContract.address]))[1];
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  (await time.latest()) + 30, 
                {value: ethSentIn}
            )

            const balanceAfter = await testContract.balanceOf(alice.address);
            const parsedExpected = parseFloat(formatEther(expectedToGet));
            const parsedBalance = parseFloat(formatEther(balanceAfter.sub(balanceBefore)));

            expect(parsedExpected).to.be.eq(parsedBalance);
        });
        it("swapETHForExactTokens", async() => {
            // Set taxes
            await routerContract.setTaxes(testContract.address, ethAddress, 0, 4500, owner.address);
            // Alice tries to swap some tokens
            const balanceBefore = await testContract.balanceOf(alice.address);
            const ethNeeded = (await pcsRouterContract.getAmountsIn(parseEther("5"), [MyWBNBContract.address, testContract.address]))[0].mul(100).div(55);
            // Reduce by 1% tax tier level: 1 - 0.01 => 0.99.
            // RouterV2: Plain 4 eth less.
            const expectedToGet = (await pcsRouterContract.getAmountsOut(parseEther("4.95"), [MyWBNBContract.address, testContract.address]))[1].sub(parseEther("4"));
            await routerByAlice.swapETHForExactTokens(
                expectedToGet, [MyWBNBContract.address, testContract.address], 
                alice.address,  (await time.latest()) + 30, 
                {value: ethNeeded}
            )

            const balanceAfter = await testContract.balanceOf(alice.address);
            const parsedExpected = parseFloat(formatEther(expectedToGet));
            const parsedBalance = parseFloat(formatEther(balanceAfter.sub(balanceBefore)));

            expect(parsedExpected).to.be.eq(parsedBalance);
        });
        it("swapTokensForExactETH", async () => {
            // Set taxes
            await routerContract.setTaxes(testContract.address, ethAddress, 1500, 2000, owner.address);
            // Alice tries to swap some tokens
            const balanceBefore = await alice.getBalance();
            const ethToGet = parseEther("5");
            const tokensNeeded  = (await pcsRouterContract.getAmountsIn(ethToGet, [MyWBNBContract.address, testContract.address]))[0];
            // Reduce by 1% cause of tax tier level: 85% - 1% => 84%.
            // RouterV2: Plain 2 eth less.
            const expectedToGet = ethToGet.mul(84).div(100).sub(parseEther("2"));

            const transaction = await routerByAlice.swapTokensForExactETH(
                ethToGet, tokensNeeded, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            );
            const receipt = await transaction.wait();
            const transactionCost = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice);
            
            const balanceAfter = await alice.getBalance();
            const parsedExpected = parseFloat(formatEther(expectedToGet.sub(transactionCost)));
            const parsedBalance = parseFloat(formatEther(balanceAfter.sub(balanceBefore)));

            expect(parsedExpected).to.be.eq(parsedBalance);
        });
        it("swapExactTokensForETH", async() => {
            // Set taxes
            await routerContract.setTaxes(testContract.address, ethAddress, 6239, 1337, owner.address);
            // Alice tries to swap some tokens
            const balanceBefore = await alice.getBalance();
            const ethToGet = parseEther("42");
            const tokensNeeded  = (await pcsRouterContract.getAmountsIn(ethToGet, [MyWBNBContract.address, testContract.address]))[0];
            // Reduce by 1% cause of tax tier level: 3761 - 100 => 3661.
            // RouterV2: Plain 3 eth less.
            const expectedToGet = ethToGet.mul(3661).div(10000).sub(parseEther("3"));

            const transaction = await routerByAlice.swapExactTokensForETH(
                tokensNeeded, expectedToGet, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            );
            const receipt = await transaction.wait();
            const transactionCost = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice);
            
            const balanceAfter = await alice.getBalance();
            const parsedExpected = parseFloat(formatEther(expectedToGet.sub(transactionCost)));
            const parsedBalance = parseFloat(formatEther(balanceAfter.sub(balanceBefore)));

            expect(parsedExpected).to.be.eq(parsedBalance);
        });
    });
    describe("Withdraw router rewards", async() => {
        let routerByAlice: CCMRouter;
        let routerByBob: CCMRouter;
        beforeEach(async() => {
            // Prepare contract.
            testContract = await (await ethers.getContractFactory("TestContract")).deploy(routerContract.address);
            testContract.transfer(alice.address, parseEther("1000"));
            testContract.transfer(bob.address,  parseEther("1000"));
            // Deploy second contract for pairing. Let's take MyWBNB.
            
            MyWBNBContract.transfer(alice.address, parseEther("1000"));
            MyWBNBContract.transfer(bob.address,  parseEther("1000"));
            // Create pair.
            const pairAddress = (await factoryContract.callStatic.createPair(testContract.address, MyWBNBContract.address));
            await factoryContract.createPair(testContract.address, MyWBNBContract.address);
            testMyWBNBPair = await pairFactory.attach(pairAddress);
            await testContract.setIsPair(pairAddress, 1);
            // Provide liquidity.
            await testContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidityETH(
                testContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                owner.address, (await time.latest()) + 300,
                {value: parseEther("100")}
            );
            // Prepare alice.
            routerByAlice = await routerContract.connect(alice); 
            await approveTestContract(testContract, alice, routerByAlice.address);
            // Prepare bob
            routerByBob = await routerContract.connect(bob);
            await approveTestContract(testContract, bob, routerByBob.address);
            // Activate taxes
            await routerContract.claimInitialFeeOwnership(testContract.address);
        });
        it("Withdraw ETH that has been gathered for trades of 1% fee", async() => {
            await routerContract.chooseTaxTierLevel(testContract.address);
            await routerContract.setTaxes(testContract.address, ethAddress, 2000, 1000, owner.address);
            
            const aliceBefore = await testContract.balanceOf(alice.address);
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], alice.address, (await time.latest()) + 300,
                { value: parseEther("5")}
            );
            expect((await routerContract.routerTaxesEarned(ethAddress))).to.deep.equal(parseEther("0.05"));
            const aliceAfterOne = await testContract.balanceOf(alice.address);
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], alice.address, (await time.latest()) + 300,
                { value: parseEther("5")}
            );
            const aliceAfterTwo = await testContract.balanceOf(alice.address);
            // Bob buy
            const bobBefore = await testContract.balanceOf(bob.address);
            await routerByBob.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], bob.address, (await time.latest()) + 300,
                { value: parseEther("5")}
            );
            const bobAfter = await testContract.balanceOf(bob.address);
            const bobPurchasedTokens = bobAfter.sub(bobBefore);
            const bobETHFromSell = (await pcsRouterContract.getAmountsOut(bobPurchasedTokens, [testContract.address, MyWBNBContract.address]))[1];
            const ethFeeFromBobSell = bobETHFromSell.mul(1500).div(10000);
            // Bob sell
            await routerByBob.swapExactTokensForETH(
                bobPurchasedTokens, 0, [testContract.address, MyWBNBContract.address], bob.address, (await time.latest()) + 300
            );
            const alicePurchasedTokens = aliceAfterTwo.sub(aliceAfterOne);
            const aliceETHFromSell = (await pcsRouterContract.getAmountsOut(alicePurchasedTokens, [testContract.address, MyWBNBContract.address]))[1];
            const ethFeeFromAliceSell = aliceETHFromSell.mul(1500).div(10000);
            // Alice sell
            await routerByAlice.swapExactTokensForETH(
                aliceAfterTwo.sub(aliceAfterOne), 0, [testContract.address, MyWBNBContract.address], alice.address, (await time.latest()) + 300
            );

            // Claim router rewards
            const ownerBalanceBefore = await owner.getBalance();
            const txn = await (await routerContract.withdrawRouterTaxes(ethAddress)).wait();
            const txnCost = txn.effectiveGasPrice.mul(txn.gasUsed);
            const ownerBalanceAfter = await owner.getBalance();

            // 1% of 15 eth buy and two sells, also with 1%. Subtract txn costs as well.
            const expectedBalanceIncrease = parseEther("15").div(100).add(bobETHFromSell.div(100)).add(aliceETHFromSell.div(100)).sub(txnCost);
            expect(ownerBalanceAfter).to.be.eq(ownerBalanceBefore.add(expectedBalanceIncrease));
            expect(await routerContract.routerTaxesEarned(testContract.address)).eq(0);
        });
        it("Withdraw ETH that has been gathered for trades of 0.3% fee", async() => {
            await routerContract.chooseTaxTierLevel(testContract.address, {value: parseEther("1")});
            await routerContract.setTaxes(testContract.address, ethAddress, 2000, 1000, owner.address);
            
            const aliceBefore = await testContract.balanceOf(alice.address);
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], alice.address, (await time.latest()) + 300,
                { value: parseEther("5")}
            );
            const aliceAfterOne = await testContract.balanceOf(alice.address);
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], alice.address, (await time.latest()) + 300,
                { value: parseEther("5")}
            );
            const aliceAfterTwo = await testContract.balanceOf(alice.address);
            // Bob buy
            const bobBefore = await testContract.balanceOf(bob.address);
            await routerByBob.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], bob.address, (await time.latest()) + 300,
                { value: parseEther("5")}
            );
            const bobAfter = await testContract.balanceOf(bob.address);
            const bobPurchasedTokens = bobAfter.sub(bobBefore);
            const bobETHFromSell = (await pcsRouterContract.getAmountsOut(bobPurchasedTokens, [testContract.address, MyWBNBContract.address]))[1];
            const ethFeeFromBobSell = bobETHFromSell.mul(1500).div(10000);
            // Bob sell
            await routerByBob.swapExactTokensForETH(
                bobPurchasedTokens, 0, [testContract.address, MyWBNBContract.address], bob.address, (await time.latest()) + 300
            );
            const alicePurchasedTokens = aliceAfterTwo.sub(aliceAfterOne);
            const aliceETHFromSell = (await pcsRouterContract.getAmountsOut(alicePurchasedTokens, [testContract.address, MyWBNBContract.address]))[1];
            const ethFeeFromAliceSell = aliceETHFromSell.mul(1500).div(10000);
            // Alice sell
            await routerByAlice.swapExactTokensForETH(
                aliceAfterTwo.sub(aliceAfterOne), 0, [testContract.address, MyWBNBContract.address], alice.address, (await time.latest()) + 300
            );

            // Claim router rewards
            const ownerBalanceBefore = await owner.getBalance();
            const txn = await (await routerContract.withdrawRouterTaxes(ethAddress)).wait();
            const txnCost = txn.effectiveGasPrice.mul(txn.gasUsed);
            const ownerBalanceAfter = await owner.getBalance();

            // 1% of 15 eth buy and two sells, also with 1%. Subtract txn costs as well.
            // Also we sent in 1 eth initially to active fees, so plus that!
            const expectedBalanceIncrease = parseEther("1").add(parseEther("15").mul(3).div(1000)).add(bobETHFromSell.mul(3).div(1000)).add(aliceETHFromSell.mul(3).div(1000)).sub(txnCost);
            expect(ownerBalanceAfter).to.be.eq(ownerBalanceBefore.add(expectedBalanceIncrease));
            expect(await routerContract.routerTaxesEarned(testContract.address)).eq(0);
        });
        it("Only owner", async() => {
            await expect(routerByAlice.withdrawRouterTaxes(ethAddress)).to.be.revertedWith("Ownable: caller is not the owner");
        });
    });*/
})

// Utilities
const approveTestContract = async(testContract: TestContract, signer: Signer, to: string) => {
    (await (await testContract.connect(signer)).approve(to, ethers.constants.MaxUint256))
}
const approveMyWBNBContract = async(MyWBNBContract: MyWBNB, signer: Signer, to: string) => {
    (await (await MyWBNBContract.connect(signer)).approve(to, ethers.constants.MaxUint256))
}