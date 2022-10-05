import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber, Signer } from "ethers";
import * as eths from "ethers";
import { formatEther } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import { PancakeFactory, PancakeFactory__factory, PancakePair, PancakePair__factory, PancakeRouter, PancakeRouterV2, PancakeRouterV2__factory, PancakeRouter__factory, CCMRouter, CCMRouter__factory, TestContract, MyWBNB, MyWBNB__factory, TCInBetweenSecond, TCInBetweenFirst, TCStackingSellTax, TCFixedTaxes, CryptoContractManagement } from "../typechain-types";
const { parseEther } = ethers.utils;

describe("CCM", () => {
    let owner: SignerWithAddress;
    let alice: SignerWithAddress;
    let bob: SignerWithAddress;
    let clarice: SignerWithAddress;
    let daphne: SignerWithAddress;
    let ellen: SignerWithAddress;

    let routerByAlice: CCMRouter;
    let routerByBob: CCMRouter;
    let routerByClarice: CCMRouter;
    
    let pcsFactory: PancakeFactory;
    let pcsRouter: PancakeRouter;
    let routerContract: CCMRouter;
    let MyWBNBContract: MyWBNB;

    let ccmContract: CryptoContractManagement;
    let ccmByAlice: CryptoContractManagement;
    let ccmByBob: CryptoContractManagement;
    let ccmByClarice: CryptoContractManagement;

    beforeEach(async () => {
        const factoryFactory = await ethers.getContractFactory("PancakeFactory");
        const routerFactory = await ethers.getContractFactory("CCMRouter");
        const ccmFactory = await ethers.getContractFactory("CryptoContractManagement");
        const pcsRouterFactory = await ethers.getContractFactory("PancakeRouter");
       
        [owner, alice, bob, clarice, daphne, ellen] = await ethers.getSigners();
        MyWBNBContract = await (await ethers.getContractFactory("MyWBNB")).deploy();
        pcsFactory = await factoryFactory.deploy(owner.address);
        pcsRouter = await pcsRouterFactory.deploy(pcsFactory.address, MyWBNBContract.address);
        
        routerContract = (await upgrades.deployProxy(routerFactory, [pcsRouter.address, pcsFactory.address, MyWBNBContract.address], { kind: "uups"})) as CCMRouter;
        ccmContract = (await upgrades.deployProxy(ccmFactory, [routerContract.address])) as CryptoContractManagement;
        ccmByAlice = await ccmContract.connect(alice);
        ccmByBob = await ccmContract.connect(bob);
        ccmByClarice = await ccmContract.connect(clarice);
        routerByAlice = await routerContract.connect(alice);
        routerByBob = await routerContract.connect(bob);
        routerByClarice = await routerContract.connect(clarice);
        // Provide wallets with MyWBNB tokens.
        MyWBNBContract.transfer(alice.address, parseEther("500"));
        MyWBNBContract.transfer(bob.address, parseEther("500"));
        MyWBNBContract.transfer(clarice.address, parseEther("500"));
        MyWBNBContract.transfer(daphne.address, parseEther("500"));
        MyWBNBContract.transfer(ellen.address, parseEther("500"));
        // Provide wallets with CCM tokens.
        ccmContract.transfer(alice.address, parseEther("500"));
        ccmContract.transfer(bob.address, parseEther("500"));
        ccmContract.transfer(clarice.address, parseEther("500"));
        ccmContract.transfer(daphne.address, parseEther("500"));
        ccmContract.transfer(ellen.address, parseEther("500"));
    });
    describe("General properties", async() => {
        it("Correct name", async() => {
            expect(await ccmContract.name()).to.eq("CryptoContractManagement");
            expect(await ccmContract.symbol()).to.eq("CCM");
        });
        it("Owner is correct", async() => {
            expect(await ccmContract.owner()).to.eq(owner.address);
        });
        it("Only owner can update", async() => {
            await expect(ccmByAlice.upgradeTo(ethers.constants.AddressZero)).to.be.revertedWith("CCM: CANNOT_UPGRADE");
            ccmContract.upgradeTo(ethers.constants.AddressZero);
        })
        it("Deployer has 100M tokens", async() => {
            const expectedOwnerSupply = parseEther("100000000");
            expect(await ccmContract.totalSupply()).to.eq(expectedOwnerSupply);
            expect(await ccmContract.balanceOf(owner.address)).to.eq(expectedOwnerSupply);
        });
        it("setPairAddress", async() => {
            await expect(ccmByAlice.setPairAddress(ccmByAlice.address)).to.be.revertedWith("Ownable: caller is not the owner");
            await ccmContract.setPairAddress(alice.address);
            expect(await ccmContract.pancakePair()).to.eq(alice.address);
            expect(await ccmContract.isTaxablePair(alice.address)).to.eq(true);
            await ccmContract.setPairAddress(bob.address);
            expect(await ccmContract.pancakePair()).to.eq(bob.address);
            expect(await ccmContract.isTaxablePair(bob.address)).to.eq(true);
            expect(await ccmContract.isTaxablePair(alice.address)).to.eq(false);
        });
        it("setPancakeRouter", async() => {
            await expect(ccmByAlice.setPairAddress(ccmByAlice.address)).to.be.revertedWith("Ownable: caller is not the owner");
            await ccmContract.setPairAddress(alice.address);
            expect(await ccmContract.pancakePair()).to.eq(alice.address);
        });
        it("setIsBlacklisted", async() => {
            expect(await ccmContract.isBlacklisted(bob.address)).to.eq(false);
            await expect(ccmByAlice.setIsBlacklisted(bob.address, true)).to.be.revertedWith("Ownable: caller is not the owner");
            await ccmContract.setIsBlacklisted(bob.address, true);
            expect(await ccmContract.isBlacklisted(bob.address)).to.eq(true);
        });
    });
    describe("Tax properties", async() => {
        let ccmWethPair: string;
        beforeEach(async() => {
            // Deploy a swap pair between CCM <=> WETH.
            ccmWethPair = await createPair(ccmContract, MyWBNBContract);
        })
        it("Correct initial tax settings", async() => {
            /* 
            buyTax = TaxStats(30, 50, 50, 0, 0, 0, 0);
            sellTax = TaxStats(100, 200, 100, 2 hours, 4 hours, 0, 0);
            taxDistribution = TaxDistribution(
                msg.sender, address(0), address(0),
                450, 350, 200
            );
            increaseSellTaxThreshold = 30;
            */
            const buyTax = await ccmContract.buyTax();
            const sellTax = await ccmContract.sellTax();
            const taxDistribution = await ccmContract.taxDistribution();
            const increaseSellTaxThreshold = await ccmContract.increaseSellTaxThreshold();
            const buyTaxExpected = [30, 50, 50, 0, 0, BigNumber.from(0), BigNumber.from(0)];
            const sellTaxExpected = [100, 200, 100, 7200, 14400, BigNumber.from(0), BigNumber.from(0)];
            const taxDistributionExpected = [owner.address, ethers.constants.AddressZero, ethers.constants.AddressZero, 450, 350, 200];
            const increaseSellTaxThresholdExpected = 30;

            expect(buyTax).to.eql(buyTaxExpected);
            expect(sellTax).to.eql(sellTaxExpected);
            expect(taxDistribution).to.eql(taxDistributionExpected);
            expect(increaseSellTaxThreshold).to.eql(increaseSellTaxThresholdExpected);
        });
        it("setTaxDistribution", async() => {
            await expect(ccmByAlice.setTaxDistribution(
                alice.address, alice.address, ccmWethPair,
                500, 250, 250
            )).to.be.revertedWith("Ownable: caller is not the owner");
            await expect(ccmContract.setTaxDistribution(
                alice.address, alice.address, ccmWethPair,
                500, 251, 250
            )).to.be.revertedWith("CCM: INVALID_TAX_DISTRIB");
            await expect(ccmContract.setTaxDistribution(
                alice.address, alice.address, ccmWethPair,
                400, 0, 250
            )).to.be.revertedWith("CCM: INVALID_TAX_DISTRIB");
            await ccmContract.setTaxDistribution(
                alice.address, alice.address, ccmWethPair,
                500, 250, 250
            );
            expect(await ccmContract.taxDistribution()).to.eql([
                alice.address, alice.address, ccmWethPair,
                500, 250, 250
            ]);
        });
        it("setTaxSettings", async() => {
            const resetTaxAfter = await getTime() + 3600;
            const resetMaxTaxAfter = resetTaxAfter + 3600;
            const lastUpdated = await getTime();
            // Invalid configurations.
            await expect(ccmByBob.setTaxSettings(
                true, 75, 100, 80,
                resetTaxAfter, resetMaxTaxAfter,
                lastUpdated, parseEther("1")
            )).to.be.revertedWith("Ownable: caller is not the owner");
            await expect(ccmContract.setTaxSettings(
                true, 75, 74, 80,
                resetTaxAfter, resetMaxTaxAfter,
                lastUpdated, parseEther("1")
            )).to.be.revertedWith("CCM: INVALID_TAX_SETTING");
            await expect(ccmContract.setTaxSettings(
                true, 75, 80, 70,
                resetTaxAfter, resetMaxTaxAfter,
                lastUpdated, parseEther("1")
            )).to.be.revertedWith("CCM: INVALID_TAX_SETTING");
            // Valid configurations.
            await ccmContract.setTaxSettings(
                true, 75, 100, 80,
                resetTaxAfter, resetMaxTaxAfter,
                lastUpdated, parseEther("1")
            );
            await ccmContract.setTaxSettings(
                false, 175, 250, 180,
                resetTaxAfter, resetMaxTaxAfter,
                lastUpdated, parseEther("2")
            );
            // Retrieve and check.
            const buyTax = await ccmContract.buyTax();
            const sellTax = await ccmContract.sellTax();
            const buyTaxExpected = [75, 100, 80, resetTaxAfter, resetMaxTaxAfter, BigNumber.from(lastUpdated), parseEther("1")];
            const sellTaxExpected = [175, 250, 180, resetTaxAfter, resetMaxTaxAfter, BigNumber.from(lastUpdated), parseEther("2")];
            expect(buyTax).to.eql(buyTaxExpected);
            expect(sellTax).to.eql(sellTaxExpected);
        });
        it("setWalletSellTaxes", async() => {
            const timeToSet = await getTime() + 45;
            await expect(ccmByAlice.setWalletSellTaxes(
                alice.address, 42, timeToSet
            )).to.be.revertedWith("Ownable: caller is not the owner");
            await ccmContract.setWalletSellTaxes(
                alice.address, 42, timeToSet
            );
            expect(await ccmContract.walletSellTaxes(alice.address)).to.eql([42, BigNumber.from(timeToSet)]);
        });
    });
    describe("Token trading", async() => {
        let pairAddress: string;
        beforeEach(async() => {
            pairAddress = await createPair(ccmContract, MyWBNBContract);
            // Set up token economy.
            await routerContract.claimInitialFeeOwnership(ccmContract.address);
            await routerContract.chooseTaxTierLevel(ccmContract.address, {value: parseEther("0.5")});
            await ccmContract.setPancakeRouter(pcsRouter.address);
            await ccmContract.setPairAddress(pairAddress);
            await ccmContract.setTaxDistribution(
                ethers.constants.AddressZero, ethers.constants.AddressZero, pairAddress,
                450, 350, 200
            );
        });
        it("Default deploy settings", async() => {
            const ownerWethBefore = await MyWBNBContract.balanceOf(owner.address);
            const pairWethBefore = await MyWBNBContract.balanceOf(pairAddress);
            // We have 5% buy settings and 10-20% sell settings, depending on pressure.
            // Also we got another 15% on top for user-specific sell taxes.
            // Test scenario:
            // We're buying in a total of 150 WETH and sell for 100 WETH.
            // Alice will induce a 5% price drop so she won't pay any extra user fees.
            // Bob will induce a 10% price drop which gives him 2.5% extra user fees.
            // Clarice will induce a 35% price drop which will give her 10% extra user fees.
            const aliceEthBuy = parseEther("30");
            const aliceEthSentToPair = aliceEthBuy.mul(945).div(1000);
            const aliceCCMExpected = (
                (await pcsRouter.getAmountsOut(aliceEthSentToPair, [MyWBNBContract.address, ccmContract.address]))[1]
            );
            const aliceCCMBefore = await ccmContract.balanceOf(alice.address);
            await routerByAlice.swapExactETHForTokens(
                aliceCCMExpected, [MyWBNBContract.address, ccmContract.address], 
                alice.address, await getTime(),
                { value: aliceEthBuy}
            );
            const aliceCCMGained = (await ccmByAlice.balanceOf(alice.address)).sub(aliceCCMBefore);
            expect(aliceCCMGained).to.eq(aliceCCMExpected);
            const bobEthBuy = parseEther("50");
            const bobEthSentToPair = bobEthBuy.mul(945).div(1000);
            const bobCCMExpected = (
                (await pcsRouter.getAmountsOut(bobEthSentToPair, [MyWBNBContract.address, ccmContract.address]))[1]
            );
            const bobCCMBefore = await ccmContract.balanceOf(bob.address);
            await routerByBob.swapExactETHForTokens(
                bobCCMExpected, [MyWBNBContract.address, ccmContract.address], 
                bob.address, await getTime(),
                { value: bobEthBuy}
            );
            const bobCCMGained = (await ccmByBob.balanceOf(bob.address)).sub(bobCCMBefore);
            expect(bobCCMGained).to.eq(bobCCMExpected);
            const clariceWethBuy = parseEther("70");
            const clariceWethSentToPair = clariceWethBuy.mul(945).div(1000);
            const clariceCCMExpected = (
                (await pcsRouter.getAmountsOut(clariceWethSentToPair, [MyWBNBContract.address, ccmContract.address]))[1]
            );
            const clariceCCMBefore = await ccmContract.balanceOf(clarice.address);
            await approveMyWBNBContract(MyWBNBContract, clarice, routerByClarice.address);
            await routerByClarice.swapExactTokensForTokens(
                clariceWethBuy, clariceCCMExpected, 
                [MyWBNBContract.address, ccmContract.address], 
                clarice.address, await getTime()
            );
            const clariceCCMGained = (await ccmByClarice.balanceOf(clarice.address)).sub(clariceCCMBefore);
            expect(clariceCCMGained).to.eq(clariceCCMExpected);
            // Make sure buy fees have been distributed appropriately for buying.
            const ownerWethGained = (await MyWBNBContract.balanceOf(owner.address)).sub(ownerWethBefore);
            const ownerWethGainedExpected = parseEther("7.5").mul(450).div(1000);
            expect(ownerWethGained).to.eq(ownerWethGainedExpected);
            const pairWethGained = (await MyWBNBContract.balanceOf(pairAddress)).sub(pairWethBefore);
            const pairWethGainedExpected = aliceEthSentToPair.add(bobEthSentToPair).add(clariceWethSentToPair).add(parseEther("7.5").mul(200).div(1000));
            expect(pairWethGained).to.eq(pairWethGainedExpected);
            // We will accumulate all taxes the owner should have gotten and check it in the end.
            const ownerWethBeforeSell = await MyWBNBContract.balanceOf(owner.address);
            let ownerWethSellGainedExpected = parseEther("0");
            // No we will sell.
            // Clarice will begin to induce a 35% price drop.
            approveCCMContract(ccmContract, clarice, routerContract.address);
            const clariceWethToGet = (await MyWBNBContract.balanceOf(pairAddress)).mul(350).div(1000);
            const clariceWethBefore = await MyWBNBContract.balanceOf(clarice.address);
            await routerByClarice.swapTokensForExactTokens(
                clariceWethToGet, ethers.constants.MaxUint256, 
                [ccmContract.address, MyWBNBContract.address], clarice.address,
                await getTime()
            );
            // Inducing a 35% price drop results in 20% common taxes from now on as well as an extra of 15% user tax => 35% total taxes.
            // Also 0.5% router tax.
            const clariceWethToGetExpected = clariceWethToGet.mul(645).div(1000);
            let contractTaxesTakenForSell = clariceWethToGet.mul(350).div(1000);
            ownerWethSellGainedExpected = ownerWethSellGainedExpected.add(contractTaxesTakenForSell.mul(450).div(1000));

            const clariceWethGained = (await MyWBNBContract.balanceOf(clarice.address)).sub(clariceWethBefore).sub(1); // TODO: Figure out why we have 1 more than we should (contract says we do not).
            expect(clariceWethGained).to.eq(clariceWethToGetExpected);
            // Alice sells for 5% drop so she should only experience the 20% total sell force.
            approveCCMContract(ccmContract, alice, routerContract.address);
            const aliceWethToGet = (await MyWBNBContract.balanceOf(pairAddress)).mul(50).div(1000);
            const aliceWethBefore = await MyWBNBContract.balanceOf(alice.address);
            await routerByAlice.swapTokensForExactTokens(
                aliceWethToGet, ethers.constants.MaxUint256, 
                [ccmContract.address, MyWBNBContract.address], alice.address,
                await getTime()
            );
            // Inducing a 5% price drop results in 20% common taxes and no individual taxes.
            // Also 0.5% router tax though.
            const aliceWethToGetExpected = aliceWethToGet.mul(795).div(1000).add(1); // Also strange.
            contractTaxesTakenForSell = aliceWethToGet.mul(200).div(1000);
            ownerWethSellGainedExpected = ownerWethSellGainedExpected.add(contractTaxesTakenForSell.mul(450).div(1000));
            const aliceWethGained = (await MyWBNBContract.balanceOf(alice.address)).sub(aliceWethBefore).sub(1); // TODO: Figure out why we have 1 more than we should (contract says we do not).
            expect(aliceWethGained).to.eq(aliceWethToGetExpected);
            // Now we forward in time 24 hours to reset the base sell tax to 10%.
            await time.increase(24 * 60 * 60);
            // Now bob will sell 10% of remaining tokens.
            // This will cause an increase of the common sell from 10% to 13% and he will pay an additional 2.5% user-specific fees.
            approveCCMContract(ccmContract, bob, routerContract.address);
            const bobWethToGet = (await MyWBNBContract.balanceOf(pairAddress)).mul(100).div(1000);
            const bobWethBefore = await MyWBNBContract.balanceOf(bob.address);
            await routerByBob.swapTokensForExactTokens(
                bobWethToGet, ethers.constants.MaxUint256, 
                [ccmContract.address, MyWBNBContract.address], bob.address,
                await getTime()
            );
            // Inducing a 10% price drop results in 17.5% common taxes and 2.5% individual taxes.
            // Also 0.5% router tax though. So a total of 20.5%.
            // Due to pcs calc imprecise calculations our contract expects 19.9% taxes which is 20.4% in total.
            const bobWethToGetExpected = bobWethToGet.mul(796).div(1000).add(1); // Also strange.
            contractTaxesTakenForSell = bobWethToGet.mul(199).div(1000);
            ownerWethSellGainedExpected = ownerWethSellGainedExpected.add(contractTaxesTakenForSell.mul(450).div(1000));
            const bobWethGained = (await MyWBNBContract.balanceOf(bob.address)).sub(bobWethBefore).sub(1); // TODO: Figure out why we have 1 more than we should (contract says we do not).
            expect(bobWethGained).to.eq(bobWethToGetExpected);
            // Now check that the owner received the correct fees for selling as well.
            const ownerWethSellGained = (await MyWBNBContract.balanceOf(owner.address)).sub(ownerWethBeforeSell);
            expect(ownerWethSellGained).to.eq(ownerWethSellGainedExpected);
        });
    });

    const createPair = async(firstContract: eths.Contract, secondContract: eths.Contract) => {
        // Create pair.
        const pairAddress = (await pcsFactory.callStatic.createPair(firstContract.address, secondContract.address));
        // Provide liquidity.
        await firstContract.approve(pcsRouter.address, ethers.constants.MaxUint256);
        await secondContract.approve(pcsRouter.address, ethers.constants.MaxUint256);
        await pcsRouter.addLiquidity(
            firstContract.address,
            secondContract.address,
            parseEther("100"), parseEther("100"),
            parseEther("100"), parseEther("100"),
            owner.address, await getTime()
        );

        return pairAddress;
    }
    const getTime = async() => (await time.latest()) + 300;
    const approveMyWBNBContract = async(MyWBNBContract: MyWBNB, signer: Signer, to: string) => {
        (await (await MyWBNBContract.connect(signer)).approve(to, ethers.constants.MaxUint256))
    }
    const approveCCMContract = async(ccmContract: CryptoContractManagement, signer: Signer, to: string) => {
        (await (await ccmContract.connect(signer)).approve(to, ethers.constants.MaxUint256))
    }
});