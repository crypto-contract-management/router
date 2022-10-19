import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber, Signer } from "ethers";
import * as eths from "ethers";
import { formatEther } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import { PancakeFactory, PancakeFactory__factory, PancakePair, PancakePair__factory, PancakeRouter, PancakeRouterV2, PancakeRouterV2__factory, PancakeRouter__factory, CCMRouter, CCMRouter__factory, TestContract, MyWBNB, MyWBNB__factory, TCInBetweenSecond, TCInBetweenFirst, TCStackingSellTax, TCFixedTaxes } from "../typechain-types";
const { parseEther } = ethers.utils;

// Anything below 10 difference is sufficiently equal enough (rounding errors).
const numEq = (n1: BigNumber, n2: BigNumber) =>
    expect(n1.sub(n2).abs()).to.be.lte(BigNumber.from(10))

describe("CCM", () => {
    let owner: SignerWithAddress;
    let alice: SignerWithAddress;
    let bob: SignerWithAddress;
    let routerByAlice: CCMRouter;
    let routerByBob: CCMRouter;
    let clarice: SignerWithAddress;
    let factoryContract: PancakeFactory;
    let pcsRouterContract: PancakeRouter;
    let routerContract: CCMRouter;
    let testContract: TestContract;
    let MyWBNBContract: MyWBNB;
    let pairFactory: PancakePair__factory;
    let testMyWBNBPair: PancakePair;
    const ethAddress = "0x000000000000000000000000000000000000dEaD";

    beforeEach(async () => {
        const factoryFactory = await ethers.getContractFactory("PancakeFactory");
        const routerFactory = await ethers.getContractFactory("CCMRouter");
        const pcsRouterFactory = await ethers.getContractFactory("PancakeRouter");
        pairFactory = await ethers.getContractFactory("PancakePair");
        [owner, alice, bob, clarice] = await ethers.getSigners();

        factoryContract = await factoryFactory.deploy(owner.address);
        MyWBNBContract = await (await ethers.getContractFactory("MyWBNB")).deploy();
        pcsRouterContract = await pcsRouterFactory.deploy(factoryContract.address, MyWBNBContract.address, {gasLimit: 20_000_000});
        routerContract = (await upgrades.deployProxy(routerFactory, [pcsRouterContract.address, factoryContract.address, MyWBNBContract.address], { kind: "uups"})) as CCMRouter;
        routerByAlice = await routerContract.connect(alice);
        routerByBob = await routerContract.connect(bob);
    });
    describe("Factory", () => {
        it("Is correctly deployed", async() => {
            expect(await factoryContract.feeToSetter()).eq(owner.address);
        });
    });
    describe("Pair", () => {
        let createdPair: PancakePair;
        beforeEach(async() => {
            const pairAddress = (await factoryContract.callStatic.createPair("0x8F930c2c13d9d413a670892C2Acc38C3eb4A2951", "0xEa8B7E713f75F9FDb020756d3210613cd4Fe660d"));
            await factoryContract.createPair("0x8F930c2c13d9d413a670892C2Acc38C3eb4A2951", "0xEa8B7E713f75F9FDb020756d3210613cd4Fe660d")
            createdPair = await pairFactory.attach(pairAddress);
        });
        it("Is correctly deployed", async() => {
            expect(await createdPair.factory()).eq(factoryContract.address);
        });
    });
    describe("Contract interactions", async() => {
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
            await testContract.setIsTaxablePair(pairAddress, true);
            // Provide liquidity.
            await testContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidityETH(
                testContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"), owner.address, await getTime(),
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
                alice.address, await getTime(), 
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
                alice.address,  await getTime()
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
            await testContract.setIsTaxablePair(pairAddress, true);
            // Provide liquidity.
            await testContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            const bobsPcsRouterContract = await pcsRouterContract.connect(bob);
            await bobsPcsRouterContract.addLiquidityETH(
                testContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                bob.address, await getTime(),
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
            await testContract.setIsTaxablePair(pairAddress, true);
            // Provide liquidity.
            await testContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidityETH(
                testContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                owner.address, await getTime(),
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
            await testContract.setIsTaxablePair(pairAddress, true);
            // Provide liquidity.
            await testContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidityETH(
                testContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                owner.address, await getTime(),
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
            const contractBalanceBefore = await MyWBNBContract.balanceOf(testContract.address);
            // Buy 3 times => 3 times 6% fee to pay.
            let expectedTCToGet = (await pcsRouterContract.getAmountsOut(parseEther("0.94"), [MyWBNBContract.address, testContract.address]))[1];
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  await getTime(), 
                {value: parseEther("1")}
            );
            const tokensForThisTrade = (await pcsRouterContract.getAmountsOut(parseEther("1"), [MyWBNBContract.address, testContract.address]))[1]
            expectedTCToGet = expectedTCToGet.add((await pcsRouterContract.getAmountsOut(parseEther("0.94"), [MyWBNBContract.address, testContract.address]))[1]);
            await routerByAlice.swapETHForExactTokens(
                tokensForThisTrade, [MyWBNBContract.address, testContract.address], 
                alice.address,  await getTime(), 
                {value: parseEther("1")}
            );
            expectedTCToGet = expectedTCToGet.add((await pcsRouterContract.getAmountsOut(parseEther("0.94"), [MyWBNBContract.address, testContract.address]))[1]);
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  await getTime(), 
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
                alice.address,  await getTime(), 
            )).wait();
            expectedWBNBToGet = expectedWBNBToGet.add(parseEther("1"));
            const txn2 = await(await routerByAlice.swapTokensForExactETH(
                parseEther("1"), parseEther("10"),
                [testContract.address, MyWBNBContract.address], 
                alice.address,  await getTime(), 
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
                owner.address,  await getTime(), 
                {value: parseEther("1")}
            );
            const ownerTCGained = (await testContract.balanceOf(owner.address)).sub(ownerTCBeforeBuy);
            numEq(ownerExpectedTCToGet, ownerTCGained);
            const ownerExpectedEthToGet = ((await pcsRouterContract.getAmountsOut(parseEther("1"), [testContract.address, MyWBNBContract.address]))[1]).mul(99).div(100);
            await testContract.approve(routerContract.address, ethers.constants.MaxUint256);
            const ownerEthBeforeSell = await owner.getBalance();
            const ownerTxn = await(await routerContract.swapExactTokensForETH(
                parseEther("1"), 0, [testContract.address, MyWBNBContract.address], 
                owner.address,  await getTime()
            )).wait();
            const ownerEthGained = (await owner.getBalance()).sub(ownerEthBeforeSell);
            const ownerTxnCost = ownerTxn.gasUsed.mul(ownerTxn.effectiveGasPrice);
            numEq(ownerEthGained, ownerExpectedEthToGet.sub(ownerTxnCost));
            // The contract should have earned both buy and sell taxes.
            const sellTaxesEarnedByContract = parseEther("0.15").add(expectedWBNBToGet.mul(15).div(100));
            const contractEthGained = (await MyWBNBContract.balanceOf(testContract.address))
                .sub(contractBalanceBefore);
            expect(contractEthGained).to.be.eq(sellTaxesEarnedByContract);
        });
    });
    
    describe("Test in-between token tax transfers (WETH taxes)", async() => {
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
            await testContract.setIsTaxablePair(pairAddress, true);
            // Provide liquidity.
            await testContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidityETH(
                testContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                owner.address, await getTime(),
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
            await testContract2.setIsTaxablePair(testContract2MyWBNBPair, true);
            // Provide liquidity.
            await testContract2.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidityETH(
                testContract2.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                owner.address, await getTime(),
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
                alice.address, await getTime()
            );
            // Fine. Now sell tokens worth of 20 eth of tc second to get tc first.
            const tcSecondRequiredForSell = (await pcsRouterContract.getAmountsIn(
                parseEther("20"), [testContract2.address, MyWBNBContract.address]
            ))[0];
            // Alice: Sell tc second to buy tc first!
            await routerByAlice.swapExactTokensForTokens(
                tcSecondRequiredForSell, 0,
                [testContract2.address, MyWBNBContract.address, testContract.address],
                alice.address, await getTime()
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
            await tcStackingSellContract.setIsTaxablePair(tcStackingSellContractMyWBNBPair, true);
            // Provide liquidity.
            await tcStackingSellContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await MyWBNBContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidity(
                tcStackingSellContract.address,
                MyWBNBContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"), parseEther("100"),
                owner.address, await getTime(),
            );
            // Prepare alice.
            await approveTestContract(tcStackingSellContract, alice, routerByAlice.address);
            // Prepare bob
            await approveTestContract(tcStackingSellContract, bob, routerByBob.address);
            // Init tax system.
            await routerContract.claimInitialFeeOwnership(tcStackingSellContract.address);
            await routerContract.chooseTaxTierLevel(tcStackingSellContract.address);
            // Now bob should get those taxes.
            const bobWethBefore = await MyWBNBContract.balanceOf(bob.address);
            // Now let alice trade and bob receive the fees:
            // 1. One sell for 10 WETH => 1 WETH fee.
            // 2. One sell for 15 WETH => 3 WETH fee.
            // 3. One sell for 10 WETH => 3 WETH fee.
            // 4. One buy for 25 WETH => 0 WETH fee.
            // 5. One sell for 5 WETH => 0.5 WETH fee.
            // Total fees earned: 7.5 WETH.
            let tokensNeededForSell = (await pcsRouterContract.getAmountsIn(
                parseEther("10"), [tcStackingSellContract.address, MyWBNBContract.address]
            ))[0];
            await routerByAlice.swapExactTokensForTokens(
                tokensNeededForSell, 0,
                [tcStackingSellContract.address, MyWBNBContract.address],
                alice.address, await getTime()
            );
            tokensNeededForSell = (await pcsRouterContract.getAmountsIn(
                parseEther("15"), [tcStackingSellContract.address, MyWBNBContract.address]
            ))[0];
            await routerByAlice.swapExactTokensForTokens(
                tokensNeededForSell, 0,
                [tcStackingSellContract.address, MyWBNBContract.address],
                alice.address, await getTime()
            );
            tokensNeededForSell = (await pcsRouterContract.getAmountsIn(
                parseEther("10"), [tcStackingSellContract.address, MyWBNBContract.address]
            ))[0];
            await routerByAlice.swapExactTokensForTokens(
                tokensNeededForSell, 0,
                [tcStackingSellContract.address, MyWBNBContract.address],
                alice.address, await getTime()
            );
            const tokensNeededForBuy = parseEther("10");
            await approveMyWBNBContract(MyWBNBContract, alice, routerByAlice.address);
            await routerByAlice.swapExactTokensForTokens(
                tokensNeededForBuy, 0,
                [MyWBNBContract.address, tcStackingSellContract.address],
                alice.address, await getTime()
            );
            tokensNeededForSell = (await pcsRouterContract.getAmountsIn(
                parseEther("5"), [tcStackingSellContract.address, MyWBNBContract.address]
            ))[0];
            await routerByAlice.swapExactTokensForTokens(
                tokensNeededForSell, 0,
                [tcStackingSellContract.address, MyWBNBContract.address],
                alice.address, await getTime()
            );
            // This contract has no auto claim => claim it manually.
            // First 7.5 WETH should be claimable.
            const bobWethGainedExpected = parseEther("7.5");
            const bobWethAfter = await MyWBNBContract.balanceOf(bob.address);
            const bobWethGained = bobWethAfter.sub(bobWethBefore);
            expect(bobWethGained).to.eq(bobWethGainedExpected);
        });
        it("TCF=WETH=WETH2=TCF2", async() => {
            const [firstContract, secondContract] = await createContractAndPair(
                "TCFixedTaxes", [routerContract.address], "MyWBNB", [], false);
            const [thirdContract, fourthContract] = await createContractAndPair(
                "TCFixedTaxes", [routerContract.address], "MyWBNB", [], false);
            const firstSecondAddress = await createPair(firstContract, secondContract);
            const secondThirdAddress = await createPair(secondContract, fourthContract);
            const thirdFourthAddress = await createPair(fourthContract, thirdContract);
            (await firstContract as TCFixedTaxes).setIsTaxablePair(firstSecondAddress, true);
            (await thirdContract as TCFixedTaxes).setIsTaxablePair(thirdFourthAddress, true);
            // Add taxable tokens.
            await routerContract.setTaxableToken(secondContract.address, true);
            await routerContract.setTaxableToken(fourthContract.address, true);
            // Alice swaps the 10 ETH worth of TCF.
            const tokensNeeded = (await pcsRouterContract.getAmountsIn(
                parseEther("10"), [firstContract.address, secondContract.address]
            ))[0];
            const result = await routerByAlice.callStatic.swapExactTokensForTokens(
                tokensNeeded, 0,
                [
                    firstContract.address, 
                    secondContract.address,
                    fourthContract.address,
                    thirdContract.address
                ],
                alice.address,
                await getTime()
            );
            // Cause we swap from WETH=>WETH2 we need to take 5% buy tax of the WETH2 we actually got.
            const thirdContractTokensGained = (
                await pcsRouterContract.getAmountsOut(
                    parseEther("8.4"), [secondContract.address, fourthContract.address]
                )
            )[1];
            await routerByAlice.swapExactTokensForTokens(
                tokensNeeded, 0,
                [
                    firstContract.address, 
                    secondContract.address,
                    fourthContract.address,
                    thirdContract.address
                ],
                alice.address,
                await getTime()
            );
            
            const tcfTaxGained = await secondContract.balanceOf(firstContract.address);
            const tcf2TaxGained = await fourthContract.balanceOf(thirdContract.address);
            // TCF takes 5% buy and 15% sell tax.
            // Therefore if we sell 10 ETH worth of TCF we take 15% sell at first place.
            
            // 1. TCF tax: 1.5 ETH
            // 2. TCF2 tax: 0.425 ETH
            const tcfTaxGainedExpected = parseEther("1.5");
            const tcfTax2GainedExpected = thirdContractTokensGained.mul(5).div(100);
            expect(tcfTaxGained).to.eq(tcfTaxGainedExpected);
            expect(tcf2TaxGained).to.eq(tcfTax2GainedExpected);
        });
    });
    
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
            await testContract.setIsTaxablePair(pairAddress, true);
            // Provide liquidity.
            await testContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidityETH(
                testContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                owner.address, await getTime(),
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
            // Just buy and sell as above.
            // Total of buys/sells is 100 bnb, with apprentice (0.5% tax) This makes 0.5 bnb for us/the router.
            const contractBalanceBefore = await MyWBNBContract.balanceOf(routerContract.address);
            const routerETHBefore = await routerContract.provider.getBalance(routerContract.address);
            await routerContract.chooseTaxTierLevel(testContract.address, {value: parseEther("0.5")});

            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  await getTime(), 
                {value: parseEther("10")}
            );
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  await getTime(), 
                {value: parseEther("25")}
            );
            await routerByBob.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  await getTime(), 
                {value: parseEther("22")}
            );
            // Then Alice sells three times and bob four times for a total of 43 bnb.
            await routerByAlice.swapTokensForExactETH(
                parseEther("8"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  await getTime()
            );
            await routerByAlice.swapTokensForExactETH(
                parseEther("7"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  await getTime()
            );
            await routerByAlice.swapTokensForExactETH(
                parseEther("7"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  await getTime()
            );
            await routerByBob.swapTokensForExactETH(
                parseEther("6"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  await getTime()
            );
            await routerByBob.swapTokensForExactETH(
                parseEther("5"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  await getTime()
            );
            await routerByBob.swapTokensForExactETH(
                parseEther("5"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  await getTime()
            );
            await routerByBob.swapTokensForExactETH(
                parseEther("5"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  await getTime()
            );
            const contractBalanceAfter = await MyWBNBContract.balanceOf(routerContract.address);
            const routerETHAfter = await routerContract.provider.getBalance(routerContract.address);
            // This is what the contract really earned.
            const contractETHEarned = contractBalanceAfter.sub(contractBalanceBefore);
            const routerETHEarned = routerETHAfter.sub(routerETHBefore);
            // This is what the contract itself tracked it should have earned.
            // Those two have to match of course. And both need to tell 0.5 bnb.
            const expectedETHEarned = parseEther("0.5");
            const expectedETHTaxEarned = parseEther("0.5");

            expect(contractETHEarned).eq(expectedETHEarned);
            expect(routerETHEarned).eq(expectedETHTaxEarned);
        });
        it("Tax tier level expert", async() => {
            const routerETHBefore = await routerContract.provider.getBalance(routerContract.address);
            await routerContract.chooseTaxTierLevel(testContract.address, {value: parseEther("1")});
            const routerETHEarned = (await routerContract.provider.getBalance(routerContract.address)).sub(routerETHBefore);
            // Just buy and sell as above.
            // Total of buys/sells is 100 bnb, with apprentice (0.3% tax) This makes 0.3 bnb for us/the router.
            const contractBalanceBefore = await MyWBNBContract.balanceOf(routerContract.address);
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  await getTime(), 
                {value: parseEther("10")}
            );
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  await getTime(), 
                {value: parseEther("25")}
            );
            await routerByBob.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  await getTime(), 
                {value: parseEther("22")}
            );
            // Then Alice sells three times and bob four times for a total of 43 bnb.
            await routerByAlice.swapTokensForExactETH(
                parseEther("8"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  await getTime()
            );
            await routerByAlice.swapTokensForExactETH(
                parseEther("7"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  await getTime()
            );
            await routerByAlice.swapTokensForExactETH(
                parseEther("7"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  await getTime()
            );
            await routerByBob.swapTokensForExactETH(
                parseEther("6"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  await getTime()
            );
            await routerByBob.swapTokensForExactETH(
                parseEther("5"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  await getTime()
            );
            await routerByBob.swapTokensForExactETH(
                parseEther("5"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  await getTime()
            );
            await routerByBob.swapTokensForExactETH(
                parseEther("5"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  await getTime()
            );
            const contractBalanceAfter = await MyWBNBContract.balanceOf(routerContract.address);
            // This is what the contract really earned.
            const contractETHEarned = contractBalanceAfter.sub(contractBalanceBefore);
            // This is what the contract itself tracked it should have earned.
            // Those two have to match of course. And both need to tell 0.3 bnb.
            const expectedETHEarned = parseEther("0.3");
            const expectedETHTaxEarned = parseEther("1.0");

            expect(contractETHEarned).eq(expectedETHEarned);
            expect(routerETHEarned).eq(expectedETHTaxEarned);
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
            await testContract.setIsTaxablePair(pairAddress, true);
            // Provide liquidity.
            await testContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidityETH(
                testContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                owner.address, await getTime(),
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
            await testContract.setIsTaxablePair(pairAddress, true);
            // Provide liquidity.
            await testContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidityETH(
                testContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                owner.address, await getTime(),
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
            // Alice tries to swap some tokens
            const balanceBefore = await testContract.balanceOf(alice.address);
            // Subtract another 1% for the tax tier level: 0.8 - 0.01 => 0.79.
            // RouterV2: Plain 1 eth less.
            const ethSentIn = parseEther("5");
            const ethSentInAfterFees = ethSentIn.sub(parseEther("1")).mul(99).div(100);
            const expectedToGet = (await pcsRouterContract.getAmountsOut(ethSentInAfterFees, [MyWBNBContract.address, testContract.address]))[1];
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  await getTime(), 
                {value: ethSentIn}
            )

            const balanceAfter = await testContract.balanceOf(alice.address);
            const parsedExpected = parseFloat(formatEther(expectedToGet));
            const parsedBalance = parseFloat(formatEther(balanceAfter.sub(balanceBefore)));

            expect(parsedExpected).to.be.eq(parsedBalance);
        });
        it("swapETHForExactTokens", async() => {
            // Alice tries to swap some tokens
            const balanceBefore = await testContract.balanceOf(alice.address);
            const ethNeeded = (await pcsRouterContract.getAmountsIn(parseEther("5"), [MyWBNBContract.address, testContract.address]))[0];
            // Reduce by 1% tax tier level: 1 - 0.01 => 0.99.
            // RouterV2: Plain 4 eth less.
            const ethToPutIn = (await pcsRouterContract.getAmountsOut(ethNeeded.sub(parseEther("4")), [MyWBNBContract.address, testContract.address]))[1];
            const expectedToGet = (await pcsRouterContract.getAmountsOut(ethNeeded.sub(parseEther("4")).mul(99).div(100), [MyWBNBContract.address, testContract.address]))[1]
            await routerByAlice.swapETHForExactTokens(
                ethToPutIn, [MyWBNBContract.address, testContract.address], 
                alice.address,  await getTime(), 
                {value: ethNeeded}
            )

            const balanceAfter = await testContract.balanceOf(alice.address);
            const parsedExpected = parseFloat(formatEther(expectedToGet));
            const parsedBalance = parseFloat(formatEther(balanceAfter.sub(balanceBefore)));

            expect(parsedExpected).to.be.eq(parsedBalance);
        });
        it("swapTokensForExactETH", async () => {
            // Alice tries to swap some tokens
            const balanceBefore = await alice.getBalance();
            const ethToGet = parseEther("5");
            const tokensNeeded  = (await pcsRouterContract.getAmountsIn(ethToGet, [MyWBNBContract.address, testContract.address]))[0];
            // RouterV2: Plain 2 eth less.
            const expectedToGet = ethToGet.mul(99).div(100).sub(parseEther("2"));

            const transaction = await routerByAlice.swapTokensForExactETH(
                ethToGet, tokensNeeded, [testContract.address, MyWBNBContract.address], 
                alice.address,  await getTime()
            );
            const receipt = await transaction.wait();
            const transactionCost = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice);
            
            const balanceAfter = await alice.getBalance();
            const parsedExpected = parseFloat(formatEther(expectedToGet.sub(transactionCost)));
            const parsedBalance = parseFloat(formatEther(balanceAfter.sub(balanceBefore)));

            expect(parsedExpected).to.be.eq(parsedBalance);
        });
        it("swapExactTokensForETH", async() => {
            // Alice tries to swap some tokens
            const balanceBefore = await alice.getBalance();
            const ethToGet = parseEther("42");
            const tokensNeeded  = (await pcsRouterContract.getAmountsIn(ethToGet, [MyWBNBContract.address, testContract.address]))[0];
            const expectedToGet = ethToGet.mul(99).div(100).sub(parseEther("3"));

            const transaction = await routerByAlice.swapExactTokensForETH(
                tokensNeeded, expectedToGet, [testContract.address, MyWBNBContract.address], 
                alice.address,  await getTime()
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
            await testContract.setIsTaxablePair(pairAddress, true);
            // Provide liquidity.
            await testContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidityETH(
                testContract.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"),
                owner.address, await getTime(),
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
            
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], alice.address, await getTime(),
                { value: parseEther("5")}
            );
            const aliceAfterOne = await testContract.balanceOf(alice.address);
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], alice.address, await getTime(),
                { value: parseEther("5")}
            );
            const aliceAfterTwo = await testContract.balanceOf(alice.address);
            // Bob buy
            const bobBefore = await testContract.balanceOf(bob.address);
            await routerByBob.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], bob.address, await getTime(),
                { value: parseEther("5")}
            );
            const bobAfter = await testContract.balanceOf(bob.address);
            const bobPurchasedTokens = bobAfter.sub(bobBefore);
            const bobETHFromSell = (await pcsRouterContract.getAmountsOut(bobPurchasedTokens, [testContract.address, MyWBNBContract.address]))[1];
            const ethFeeFromBobSell = bobETHFromSell.mul(1500).div(10000);
            // Bob sell
            await routerByBob.swapExactTokensForETH(
                bobPurchasedTokens, 0, [testContract.address, MyWBNBContract.address], bob.address, await getTime()
            );
            const alicePurchasedTokens = aliceAfterTwo.sub(aliceAfterOne);
            const aliceETHFromSell = (await pcsRouterContract.getAmountsOut(alicePurchasedTokens, [testContract.address, MyWBNBContract.address]))[1];
            const ethFeeFromAliceSell = aliceETHFromSell.mul(1500).div(10000);
            // Alice sell
            await routerByAlice.swapExactTokensForETH(
                aliceAfterTwo.sub(aliceAfterOne), 0, [testContract.address, MyWBNBContract.address], alice.address, await getTime()
            );

            // Claim router rewards
            const ownerBalanceBefore = await MyWBNBContract.balanceOf(owner.address);
            const txn = await (await routerContract.withdrawAnyERC20Token(MyWBNBContract.address)).wait();
            const ownerBalanceAfter = await MyWBNBContract.balanceOf(owner.address);

            // 1% of 15 eth buy and two sells, also with 1%. Subtract txn costs as well.
            const expectedBalanceIncrease = parseEther("15").div(100).add(bobETHFromSell.div(100)).add(aliceETHFromSell.div(100));
            expect(ownerBalanceAfter).to.be.eq(ownerBalanceBefore.add(expectedBalanceIncrease));
        });
        it("Withdraw ETH that has been gathered for trades of 0.3% fee", async() => {
            await routerContract.chooseTaxTierLevel(testContract.address, {value: parseEther("1")});
            const aliceBefore = await testContract.balanceOf(alice.address);
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], alice.address, await getTime(),
                { value: parseEther("5")}
            );
            const aliceAfterOne = await testContract.balanceOf(alice.address);
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], alice.address, await getTime(),
                { value: parseEther("5")}
            );
            const aliceAfterTwo = await testContract.balanceOf(alice.address);
            // Bob buy
            const bobBefore = await testContract.balanceOf(bob.address);
            await routerByBob.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], bob.address, await getTime(),
                { value: parseEther("5")}
            );
            const bobAfter = await testContract.balanceOf(bob.address);
            const bobPurchasedTokens = bobAfter.sub(bobBefore);
            const bobETHFromSell = (await pcsRouterContract.getAmountsOut(bobPurchasedTokens, [testContract.address, MyWBNBContract.address]))[1];
            const ethFeeFromBobSell = bobETHFromSell.mul(1500).div(10000);
            // Bob sell
            await routerByBob.swapExactTokensForETH(
                bobPurchasedTokens, 0, [testContract.address, MyWBNBContract.address], bob.address, await getTime()
            );
            const alicePurchasedTokens = aliceAfterTwo.sub(aliceAfterOne);
            const aliceETHFromSell = (await pcsRouterContract.getAmountsOut(alicePurchasedTokens, [testContract.address, MyWBNBContract.address]))[1];
            const ethFeeFromAliceSell = aliceETHFromSell.mul(1500).div(10000);
            // Alice sell
            await routerByAlice.swapExactTokensForETH(
                aliceAfterTwo.sub(aliceAfterOne), 0, [testContract.address, MyWBNBContract.address], alice.address, await getTime()
            );

            // Claim router rewards
            const ownerBalanceBefore = await MyWBNBContract.balanceOf(owner.address);
            const ownerEthBefore = await owner.getBalance();
            const txn = await (await routerContract.withdrawAnyERC20Token(MyWBNBContract.address)).wait();
            const txnCost = txn.effectiveGasPrice.mul(txn.gasUsed);
            const txn2 = await (await routerContract.withdrawETH()).wait();
            const txn2Cost = txn2.effectiveGasPrice.mul(txn2.gasUsed);
            const ownerBalanceAfter = await MyWBNBContract.balanceOf(owner.address);
            const ownerEthAfter = await owner.getBalance();
            const ownerEthGained = ownerEthAfter.sub(ownerEthBefore);

            // 1% of 15 eth buy and two sells, also with 1%. Subtract txn costs as well.
            // Also we sent in 1 eth initially to active fees, so plus that!
            const expectedBalanceIncrease = (parseEther("15").mul(3).div(1000)).add(bobETHFromSell.mul(3).div(1000)).add(aliceETHFromSell.mul(3).div(1000));
            expect(ownerBalanceAfter).to.be.eq(ownerBalanceBefore.add(expectedBalanceIncrease));
            expect(ownerEthGained).to.eq(parseEther("1").sub(txnCost).sub(txn2Cost));
        });
        it("Only owner", async() => {
            await expect(routerByAlice.withdrawAnyERC20Token(ethAddress)).to.be.revertedWith("Ownable: caller is not the owner");
        });
    });
    
    // Contract creations
    const createContractAndPair = async(
        firstContractName: string, firstContractParams: Array<any>,
        secondContractName: string, secondContractParams: Array<any>,
        isFirstContractTaxable: boolean) => {
            // Prepare contract.
            const firstContract = await (
                await ethers.getContractFactory(firstContractName)
            ).deploy(...firstContractParams);
            const secondContract = await (
                await ethers.getContractFactory(secondContractName)
            ).deploy(...secondContractParams);
            // Transfer some tokens.
            firstContract.transfer(alice.address, parseEther("1000"));
            firstContract.transfer(bob.address, parseEther("1000"));
            secondContract.transfer(alice.address, parseEther("1000"));
            secondContract.transfer(bob.address, parseEther("1000"));
            // Prepare alice.
            (await (await firstContract.connect(alice)).approve(routerByAlice.address, ethers.constants.MaxUint256));
            (await (await firstContract.connect(bob)).approve(routerByBob.address, ethers.constants.MaxUint256));
            (await (await secondContract.connect(alice)).approve(routerByAlice.address, ethers.constants.MaxUint256));
            (await (await secondContract.connect(bob)).approve(routerByBob.address, ethers.constants.MaxUint256));
            // Activate taxes
            if(isFirstContractTaxable){
                await routerContract.claimInitialFeeOwnership(secondContract.address);
                await routerContract.chooseTaxTierLevel(secondContract.address);
            } else {
                await routerContract.claimInitialFeeOwnership(firstContract.address);
                await routerContract.chooseTaxTierLevel(firstContract.address);
            }

            return [firstContract, secondContract];
        }
    
    const createPair = async(firstContract: eths.Contract, secondContract: eths.Contract) => {
        // Create pair.
        const pairAddress = (await factoryContract.callStatic.createPair(firstContract.address, secondContract.address));
        // Provide liquidity.
        await firstContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
        await secondContract.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
        await pcsRouterContract.addLiquidity(
            firstContract.address,
            secondContract.address,
            parseEther("100"), parseEther("100"),
            parseEther("100"), parseEther("100"),
            owner.address, await getTime()
        );

        return pairAddress;
    }
    const getTime = async() => (await time.latest()) + 300;
})

// Utilities
const approveTestContract = async(testContract: TestContract, signer: Signer, to: string) => {
    (await (await testContract.connect(signer)).approve(to, ethers.constants.MaxUint256))
}
const approveMyWBNBContract = async(MyWBNBContract: MyWBNB, signer: Signer, to: string) => {
    (await (await MyWBNBContract.connect(signer)).approve(to, ethers.constants.MaxUint256))
}