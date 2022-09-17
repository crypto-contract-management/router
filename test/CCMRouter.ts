import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber, Signer } from "ethers";
import * as eths from "ethers";
import { formatEther } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import { PancakeFactory, PancakeFactory__factory, PancakePair, PancakePair__factory, PancakeRouter, PancakeRouterV2, PancakeRouterV2__factory, PancakeRouter__factory, CCMRouter, CCMRouter__factory, TestContract, MyWBNB, MyWBNB__factory } from "../typechain-types";
const { parseEther } = ethers.utils;

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
    return;/*
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
            it("Change fees after transfer fee ownership", async() => {
                await routerByBob.claimInitialFeeOwnership(testContract.address);
                await routerByBob.transferFeeOwnership(testContract.address, alice.address);
                expect(await routerByBob.feeOwners(testContract.address)).eq(alice.address);
                await expect(routerByBob.setTaxes(testContract.address, ethAddress, 1337, 6969, bob.address)).to.be.revertedWithoutReason();
                await routerByAlice.setTaxes(testContract.address, ethAddress, 1337, 6969, alice.address);
                expect((await routerByBob.tokenTotalTaxes(testContract.address, ethAddress)).slice(0, 3)).to.deep.equal([1337, 6969, eths.BigNumber.from(0)]);
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

        describe("Set valid ETH taxes", () => {
            let testAddress: string;
            beforeEach(async() => {
                const testContractFactory = await ethers.getContractFactory("TestContract");
                testContract = await testContractFactory.deploy(routerContract.address);
                await routerContract.claimInitialFeeOwnership(testContract.address);
                testAddress = testContract.address;
            })
            it("Out: 42.42% - In: 13.37% then reset", async() => {
                // In: 13.37% - Out: 42.42% then reset
                await routerContract.setTaxes(testAddress, ethAddress, 4242, 1337, alice.address);
                expect((await routerContract.tokenTotalTaxes(testAddress, ethAddress))).to.deep.equal([4242, 1337, BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0)]);
                await routerContract.setTaxes(testAddress, ethAddress, 0, 0, alice.address);
                expect(await routerContract.tokenTotalTaxes(testAddress, ethAddress)).to.deep.equal([0, 0, BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0)]);
            });
            it("Out: 0% - In: 100% then reset", async() => {
                await routerContract.setTaxes(testAddress, ethAddress, 0, 10000, alice.address);
                expect((await routerContract.tokenTotalTaxes(testAddress, ethAddress))).to.deep.equal([0, 10000, BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0)]);
                await routerContract.setTaxes(testAddress, ethAddress, 0, 0, alice.address);
                expect(await routerContract.tokenTotalTaxes(testAddress, ethAddress)).to.deep.equal([0, 0, BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0)]);
            });
            it("Out: 100% - In: 0% then reset", async() => {
                await routerContract.setTaxes(testAddress, ethAddress, 10000, 0, alice.address);
                expect((await routerContract.tokenTotalTaxes(testAddress, ethAddress))).to.deep.equal([10000, 0, BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0)]);
                await routerContract.setTaxes(testAddress, ethAddress, 0, 0, alice.address);
                expect(await routerContract.tokenTotalTaxes(testAddress, ethAddress)).to.deep.equal([0, 0, BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0)]);
            });
            it("Out: 100% - In: 100% then reset", async() => {
                await routerContract.setTaxes(testAddress, ethAddress, 10000, 10000, alice.address);
                expect((await routerContract.tokenTotalTaxes(testAddress, ethAddress))).to.deep.equal([10000, 10000, BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0)]);
                await routerContract.setTaxes(testAddress, ethAddress, 0, 0, alice.address);
                expect(await routerContract.tokenTotalTaxes(testAddress, ethAddress)).to.deep.equal([0, 0, BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0)]);
            });
            it("Out: 99.99% - In: 99.99% then reset", async() => {
                await routerContract.setTaxes(testAddress, ethAddress, 9999, 9999, alice.address);
                expect((await routerContract.tokenTotalTaxes(testAddress, ethAddress))).to.deep.equal([9999, 9999, BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0)]);
                await routerContract.setTaxes(testAddress, ethAddress, 0, 0, alice.address);
                expect(await routerContract.tokenTotalTaxes(testAddress, ethAddress)).to.deep.equal([0, 0, BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0)]);
            });
        });
        describe("Set invalid taxes", () => {
            let testAddress: string;
            beforeEach(async() => {
                const testContractFactory = await ethers.getContractFactory("TestContract");
                testContract = await testContractFactory.deploy(routerContract.address);
                await routerContract.claimInitialFeeOwnership(testContract.address);
                testAddress = testContract.address;
            })
            it("Out: 100.1% - In: 0%", async() => {
                await expect(routerContract.setTaxes(testAddress, ethAddress, 10001, 0, alice.address)).to.be.revertedWith("CCM: INVALID_TAX");
            });
            it("Out: 13.37% - In: 133.7%", async() => {
                await expect(routerContract.setTaxes(testAddress, ethAddress, 1337, 13370, alice.address)).to.be.revertedWith("CCM: INVALID_TAX");
            });
            it("Out: 100.1% - In: 420%", async() => {
                await expect(routerContract.setTaxes(testAddress, ethAddress, 10001, 42000, alice.address)).to.be.revertedWith("CCM: INVALID_TAX");
            });
        });
    })
    describe("Send ETH [in] tax", async() => {
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
        it("swapExactETHForTokens", async() => {
            // Set taxes
            await routerContract.setTaxes(testContract.address, ethAddress, 0, 2000, owner.address);
            // Alice tries to swap some tokens
            const balanceBefore = await testContract.balanceOf(alice.address);
            // Subtract another 1% for the tax tier level: 0.8 - 0.01 => 0.79.
            const expectedToGet = (await pcsRouterContract.getAmountsOut(parseEther("0.79"), [MyWBNBContract.address, testContract.address]))[1];
            await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  (await time.latest()) + 30, 
                {value: parseEther("1")}
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
            const ethNeeded = (await pcsRouterContract.getAmountsIn(parseEther("1"), [MyWBNBContract.address, testContract.address]))[0].mul(100).div(55);
            // Reduce by 1% tax tier level: 1 - 0.01 => 0.99.
            const expectedToGet = (await pcsRouterContract.getAmountsOut(parseEther("0.99"), [MyWBNBContract.address, testContract.address]))[1];
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
    });
    describe("Retrieve ETH [out] tax", async() => {
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
            await routerContract.claimInitialFeeOwnership(testContract.address);
            // Activate taxes
            await routerContract.chooseTaxTierLevel(testContract.address);
        });
        it("swapTokensForExactETH", async () => {
            // Set taxes
            await routerContract.setTaxes(testContract.address, ethAddress, 1500, 2000, owner.address);
            // Alice tries to swap some tokens
            const balanceBefore = await alice.getBalance();
            const ethToGet = parseEther("1.5");
            const tokensNeeded  = (await pcsRouterContract.getAmountsIn(ethToGet, [MyWBNBContract.address, testContract.address]))[0];
            // Reduce by 1% cause of tax tier level: 85% - 1% => 84%.
            const expectedToGet = ethToGet.mul(84).div(100);

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
            const expectedToGet = ethToGet.mul(3661).div(10000);

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
    describe("Fee receivers get correct fees", async() => {
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
            await routerContract.chooseTaxTierLevel(testContract.address);
        });
        it("Alice gets 8% of ETH traded, Bob gets 4% (ONLY BUY)", async() => {
            // Set taxes
            await routerContract.setTaxes(testContract.address, ethAddress, 0, 800, alice.address);
            await routerContract.setTaxes(testContract.address, ethAddress, 0, 400, bob.address);
            // Alice buys three times:
            // 1. For 1 bnb
            // 2. For 5 bnb
            // 3. for 6 bnb
            // Therefore, after claiming the taxes, the receivers should have gotten:
            // Alice: 12 bnb * 0.08 = 0.96 bnb
            // Bob:   12 bnb * 0.04 = 0.48 bnb
            const aliceBalanceBefore = await alice.getBalance();
            const bobBalanceBefore = await bob.getBalance();
            const firstTransaction = (await (await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  (await time.latest()) + 30, 
                {value: parseEther("1")}
            )).wait());
            const secondTransaction = (await (await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  (await time.latest()) + 30, 
                {value: parseEther("5")}
            )).wait());
            const thirdTransaction = (await (await routerByAlice.swapExactETHForTokens(
                0, [MyWBNBContract.address, testContract.address], 
                alice.address,  (await time.latest()) + 30, 
                {value: parseEther("6")}
            )).wait());
            // Claim rewards.
            await routerContract.claimTaxes(testContract.address, ethAddress);
            // Accumulated taxes should be 0 after claiming.
            expect(await routerContract.tokenTotalTaxes(testContract.address, ethAddress)).to.deep.equal([0, 1200, BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from(0), BigNumber.from("1440000000000000000")]);
            

            const aliceBalanceAfter = await alice.getBalance();
            const aliceTransactionCost = (firstTransaction.gasUsed.mul(firstTransaction.effectiveGasPrice))
                .add((secondTransaction.gasUsed.mul(secondTransaction.effectiveGasPrice))
                .add((thirdTransaction.gasUsed.mul(thirdTransaction.effectiveGasPrice))));
            const bobBalanceAfter = await bob.getBalance();
            const aliceExpectedBalance = aliceBalanceBefore.add(parseEther("0.96")).sub(parseEther("12")).sub(aliceTransactionCost);
            const bobExpectedBalance = bobBalanceBefore.add(parseEther("0.48"));

            expect(aliceBalanceAfter).to.be.eq(aliceExpectedBalance);
            expect(bobBalanceAfter).to.be.eq(bobExpectedBalance);
        });
        it("Alice gets 22% of ETH traded, Bob gets 42% (ONLY SELL)", async() => {
            // Set taxes
            await routerContract.setTaxes(testContract.address, ethAddress, 2200, 800, alice.address);
            await routerContract.setTaxes(testContract.address, ethAddress, 4200, 400, bob.address);
            // Alice buys three times:
            // 1. For 1 bnb
            // 2. For 5 bnb
            // 3. for 6 bnb
            // Therefore, after claiming the taxes, the receivers should have gotten:
            // Alice: 12 bnb * 0.08 = 0.96 bnb
            // Bob:   12 bnb * 0.04 = 0.48 bnb
            const aliceBalanceBefore = await alice.getBalance();
            const bobBalanceBefore = await bob.getBalance();
            const firstTransaction = (await (await routerByAlice.swapTokensForExactETH(
                parseEther("2"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            )).wait());
            const secondTransaction = (await (await routerByAlice.swapTokensForExactETH(
                parseEther("5"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            )).wait());
            const thirdTransaction = (await (await routerByAlice.swapTokensForExactETH(
                parseEther("3"), ethers.constants.MaxUint256, [testContract.address, MyWBNBContract.address], 
                alice.address,  (await time.latest()) + 30
            )).wait());
            // Claim rewards.
            await routerContract.claimTaxes(testContract.address, ethAddress);

            const aliceBalanceAfter = await alice.getBalance();
            const aliceTransactionCost = (firstTransaction.gasUsed.mul(firstTransaction.effectiveGasPrice))
                .add((secondTransaction.gasUsed.mul(secondTransaction.effectiveGasPrice))
                .add((thirdTransaction.gasUsed.mul(thirdTransaction.effectiveGasPrice))));
            const bobBalanceAfter = await bob.getBalance();
            // 10 bnb gained by selling but paying 64% fee => 3.6 bnb.
            // Also alice gets 1% less due to the tax tier level (how sad!).
            // Therefore correction: 10 * 0.99 - 10 * 0.64 => 
            const aliceExpectedBalance = aliceBalanceBefore.add(parseEther("3.5")).add(parseEther("2.2")).sub(aliceTransactionCost);
            const bobExpectedBalance = bobBalanceBefore.add(parseEther("4.2"));

            expect(aliceBalanceAfter).to.be.eq(aliceExpectedBalance);
            expect(bobBalanceAfter).to.be.eq(bobExpectedBalance);
        });
        it("Owner gets 34.22% bnb out fee and 17.35% bnb in fee", async() => {
            // Set taxes
            await routerContract.setTaxes(testContract.address, ethAddress, 3422, 1735, owner.address);
            // Alice buys twice, bob once for a total of 57 bnb.
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
            // Claim rewards. Total bnb traded has been 100.
            const ownersBalanceBefore = await owner.getBalance();
            const claimTxn = await(await routerContract.claimTaxes(testContract.address, ethAddress)).wait();
            const txnCost = claimTxn.gasUsed.mul(claimTxn.effectiveGasPrice);
            const ownersBalanceAfter = await owner.getBalance();
            // 17.35% of 57 bnb and 34.22% of 43 bnb are 24.6041 bnb.
            const feeReceived = parseEther("24.6041");
            const expectedBalance = ownersBalanceBefore.add(feeReceived).sub(txnCost);

            expect(ownersBalanceAfter).eq(expectedBalance);
        });
    });
    describe("Test in-between token tax transfers (WETH taxes)", async() => {
        let routerByAlice: CCMRouter;
        let routerByBob: CCMRouter;
        let testContract2: TestContract;
        let testContract3: TestContract;
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
            await routerContract.chooseTaxTierLevel(testContract.address);
            
            // Deploy another token to swap for.
            // Path is: TestContract1 => MyWBNB => TestContract 2
            testContract2 = await (await ethers.getContractFactory("TestContract")).deploy(routerContract.address);
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
            await routerContract.setTaxes(testContract.address, MyWBNBContract.address, 2227, 6969, bob.address);
            await routerContract.claimInitialFeeOwnership(testContract2.address);
            await routerContract.chooseTaxTierLevel(testContract2.address);
            await routerContract.setTaxes(testContract2.address, MyWBNBContract.address, 6969, 5000, bob.address);
            // Provide another test contract for direct pairing to simulate trading tokens without fees.
            // Path is: TestContract1 <=> TestContract 2
            testContract3 = await (await ethers.getContractFactory("TestContract")).deploy(routerContract.address);
            testContract3.transfer(alice.address, parseEther("1000"));
            testContract3.transfer(bob.address,  parseEther("1000"));
            // Create pair.
            const testContract3MyWBNBPair = (await factoryContract.callStatic.createPair(testContract3.address, testContract2.address));
            await factoryContract.createPair(testContract3.address, testContract2.address);
            await testContract3.setIsPair(testContract3MyWBNBPair, 1);
            // Provide liquidity.
            await testContract3.approve(pcsRouterContract.address, ethers.constants.MaxUint256);
            await pcsRouterContract.addLiquidity(
                testContract3.address,
                testContract2.address,
                parseEther("100"), parseEther("100"),
                parseEther("100"), parseEther("100"),
                owner.address, (await time.latest()) + 300,
            );
            // Prepare alice.
            await approveTestContract(testContract3, alice, routerByAlice.address);
            // Prepare bob
            await approveTestContract(testContract3, bob, routerByBob.address);
            // Now we can declare the fees:
            // 1: 22.27% OUT (someone is giving tokens in and taking WETH OUT of the pool) for test contract 1
            // 2: 50% IN (someone is giving WETH IN to the pool) for test contract 2
            // The other fees (IN for test contract 1 and OUT for test contract 2) can be arbitrarily chosen
            // to make sure only the respective IN/OUT fees are taken. So they should just be greater than 0.
            // Set taxes
            await routerContract.claimInitialFeeOwnership(testContract3.address);
            await routerContract.chooseTaxTierLevel(testContract3.address);
            await routerContract.setTaxes(testContract3.address, MyWBNBContract.address, 5000, 5000, bob.address);
        });
        it("Bob gets 22.27% out fee for token1 and bob gets 36.56% in fee for token 2", async() => {
            // Alice swaps 10 WETH worth of test contract tokens to swap for test contract 2 tokens.
            const tokensNeeded = (await pcsRouterContract.getAmountsIn(parseEther("10"), [testContract.address, MyWBNBContract.address]))[0];
            // We take 22.27% of those 10 weth earned and 1% fee for the tax model, so we send in 7.673 weth.
            // Out of those 7.773 eth we take 50% as fee and again 1% tax model fee so we should expect
            // to get tokens for a weth equivalent of 3.75977.
            const expectedTokensToGet = (await pcsRouterContract.getAmountsOut(parseEther("3.75977"), [MyWBNBContract.address, testContract2.address]))[1];
            const balanceBefore = await testContract2.balanceOf(alice.address);
            await routerByAlice.swapExactTokensForTokens(tokensNeeded, 0, [testContract.address, MyWBNBContract.address, testContract2.address], alice.address, (await time.latest()) + 30);
            const tokensGained = (await testContract2.balanceOf(alice.address)).sub(balanceBefore);
            expect(tokensGained).to.deep.equal(expectedTokensToGet);
            // Bob should have gotten a total of:
            // 1. 10 * 0.2227 = 2.227
            // 2. 7.673 * 0.5 = 3.8365
            // => 6.0635 weth as fees.
            const bobWethGainsExpected = parseEther("6.0635");
            const bobWethBefore = await MyWBNBContract.balanceOf(bob.address);
            await routerContract.claimTaxes(testContract.address, MyWBNBContract.address);
            await routerContract.claimTaxes(testContract2.address, MyWBNBContract.address);
            const bobWethGained = (await MyWBNBContract.balanceOf(bob.address)).sub(bobWethBefore);
            const testContractClaimableTaxes = await routerContract.tokenTotalTaxes(testContract.address, MyWBNBContract.address);
            const testContract2ClaimableTaxes = await routerContract.tokenTotalTaxes(testContract2.address, MyWBNBContract.address);
            const remainingClaimableTaxes = testContractClaimableTaxes.outTaxClaimable
                .add(testContractClaimableTaxes.inTaxClaimable)
                .add(testContract2ClaimableTaxes.outTaxClaimable)
                .add(testContract2ClaimableTaxes.inTaxClaimable);
            expect(bobWethGained).to.deep.equal(bobWethGainsExpected);
            expect(remainingClaimableTaxes).to.deep.equal(BigNumber.from(0));
        });
        it("Bob gets 12.48% WETH out fee for token1", async() => {
            await routerContract.setTaxes(testContract.address, MyWBNBContract.address, 1248, 6969, bob.address);
            // Alice swaps 10 WETH worth of test contract tokens to swap for test contract 2 tokens.
            const tokensNeeded = (await pcsRouterContract.getAmountsIn(parseEther("10"), [testContract.address, MyWBNBContract.address]))[0];
            // We take 12.48% WETH out fee, so they should have 8.752 WETH in the end.
            // 1% tax level fees result in 8.652 WETH in the end.
            const aliceExpectedTokensToGet = parseEther("8.652");
            const balanceBefore = await MyWBNBContract.balanceOf(alice.address);
            await routerByAlice.swapExactTokensForTokens(tokensNeeded, 0, [testContract.address, MyWBNBContract.address], alice.address, (await time.latest()) + 30);
            const tokensGained = (await MyWBNBContract.balanceOf(alice.address)).sub(balanceBefore);
            expect(tokensGained).to.deep.equal(aliceExpectedTokensToGet);
            // Bob should have gotten a total of 1.248 weth.
            const bobWethGainsExpected = parseEther("1.248");
            const bobWethBefore = await MyWBNBContract.balanceOf(bob.address);
            await routerContract.claimTaxes(testContract.address, MyWBNBContract.address);
            const bobWethGained = (await MyWBNBContract.balanceOf(bob.address)).sub(bobWethBefore);
            expect(bobWethGained).to.deep.equal(bobWethGainsExpected);
        });
        it("Alice gets 25% WETH in fee for token1", async() => {
            await approveMyWBNBContract(MyWBNBContract, bob, routerByBob.address);
            // Reset other tax holder fees.
            await routerContract.setTaxes(testContract.address, MyWBNBContract.address, 0, 0, bob.address);
            await routerContract.setTaxes(testContract.address, MyWBNBContract.address, 1337, 2500, alice.address);
            // Bob swaps 10 tokens of test contract.
            const tokensNeeded = (await pcsRouterContract.getAmountsIn(parseEther("10"), [MyWBNBContract.address, testContract.address]))[0];
            // We take 25% WETH in fee and 1% tax tier level fee, so they should get tokens for 7.4 WETH in the end.
            const bobExpectedTokensToGet = ((await pcsRouterContract.getAmountsOut(
                tokensNeeded.mul(7400).div(10000), 
                [MyWBNBContract.address, testContract.address]
            ))[1]).add(1); // Round error?
            const balanceBefore = await testContract.balanceOf(bob.address);
            await routerByBob.swapExactTokensForTokens(tokensNeeded, 0, [MyWBNBContract.address, testContract.address], bob.address, (await time.latest()) + 30);
            const tokensGained = (await testContract.balanceOf(bob.address)).sub(balanceBefore);
            expect(tokensGained).to.deep.equal(bobExpectedTokensToGet);
            // Alice should have gotten a total of 2.5 weth.
            const aliceWethGainsExpected = tokensNeeded.mul(2500).div(10000);
            const aliceWethBefore = await MyWBNBContract.balanceOf(alice.address);
            await routerContract.claimTaxes(testContract.address, MyWBNBContract.address);
            const aliceWethGained = (await MyWBNBContract.balanceOf(alice.address)).sub(aliceWethBefore);
            expect(aliceWethGained).to.deep.equal(aliceWethGainsExpected);
        });
        it("Nobody gets any fees as it's a common token transfer between tokens of no taxation", async() => {
            await approveMyWBNBContract(MyWBNBContract, bob, routerByBob.address);
            // Reset other tax holder fees.
            await routerContract.setTaxes(testContract2.address, MyWBNBContract.address, 1337, 2322, bob.address);
            await routerContract.setTaxes(testContract3.address, MyWBNBContract.address, 1337, 2500, alice.address);
            // Swap 10 test contract 2 tokens without any fees for test contract 1 tokens.
            const bobExpectedTokensToGet = (await pcsRouterContract.getAmountsOut(
                parseEther("10"), [testContract2.address, testContract3.address]
            ))[1];
            const balanceBefore = await testContract3.balanceOf(bob.address);
            await routerByBob.swapExactTokensForTokens(
                parseEther("10"), bobExpectedTokensToGet, 
                [testContract2.address, testContract3.address], 
                bob.address, (await time.latest()) + 30
            );
            const tokensGained = (await testContract3.balanceOf(bob.address)).sub(balanceBefore);
            expect(tokensGained).to.deep.equal(bobExpectedTokensToGet);
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