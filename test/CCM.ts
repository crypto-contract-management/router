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
    
    let pcsFactory: PancakeFactory;
    let pcsRouter: PancakeRouter;
    let routerContract: CCMRouter;
    let MyWBNBContract: MyWBNB;

    let ccmContract: CryptoContractManagement;
    let ccmByAlice: CryptoContractManagement;

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
        routerByAlice = await routerContract.connect(alice);
        routerByBob = await routerContract.connect(bob);
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
    });
    describe("Tax properties", async() => {
        let ccmWethPair: string;
        beforeEach(async() => {
            // Deploy a swap pair between CCM <=> WETH.
            ccmWethPair = await createPair(ccmContract, MyWBNBContract);
        })
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
});