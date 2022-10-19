import { ethers, upgrades } from "hardhat";
import hre from "hardhat";
import { CCMRouter, CCMRouter__factory, CryptoContractManagement, CryptoContractManagement__factory, MyWBNB, MyWBNB__factory, TestContract, TestContract__factory } from "../typechain-types";

async function main() {
  // CCM router
  var router: CCMRouter;
  var testContract: TestContract;
  var testContract2: TestContract;
  var ccmt: CryptoContractManagement;
  var myWbnb: MyWBNB;
  const routerFactory = await hre.ethers.getContractFactory("CCMRouter") as CCMRouter__factory;
  const myWbnbFactory = await hre.ethers.getContractFactory("MyWBNB") as MyWBNB__factory;
  const tokenFactory = await hre.ethers.getContractFactory("TestContract") as TestContract__factory;
  const ccmtFactory = await hre.ethers.getContractFactory("CryptoContractManagement") as CryptoContractManagement__factory;
  if (hre.network.name == "bsc_testnet") {
    const pcsFactoryAddress = "0xB7926C0430Afb07AA7DEfDE6DA862aE0Bde767bc";
    const pcsRouterAddress = "0x9ac64cc6e4415144c455bd8e4837fea55603e5c3";
    
    myWbnb = await (await myWbnbFactory.deploy()).deployed() as MyWBNB;
    router = await (await upgrades.deployProxy(routerFactory, [pcsRouterAddress, pcsFactoryAddress, myWbnb.address], { kind: "uups"})).deployed() as CCMRouter;
    ccmt = await (await upgrades.deployProxy(ccmtFactory, [router.address, myWbnb.address], { kind: "uups"})).deployed() as CryptoContractManagement;
    //testContract = await (await tokenFactory.deploy(router.address)).deployed() as TestContract;
    //testContract2 = await (await tokenFactory.deploy(router.address)).deployed() as TestContract;
    console.log("MyWbnb contract at: ", myWbnb.address);
    console.log("Router contract at: ", router.address);
    console.log("CCMT: ", ccmt.address);
    //console.log("Test contract at: ", testContract.address);
    //console.log("Test contract 2 at: ", testContract2.address);
  } 
  else {
      console.error("Inavlid Network");
      process.exit(1);
  }
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
