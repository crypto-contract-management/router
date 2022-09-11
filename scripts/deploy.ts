import { ethers, upgrades } from "hardhat";
import hre from "hardhat";
import { CCMRouter, CCMRouter__factory, TestContract, TestContract__factory } from "../typechain-types";

async function main() {
  // CCM router
  var router: CCMRouter;
  const routerFactory = await hre.ethers.getContractFactory("CCMRouter") as CCMRouter__factory;
  var token: TestContract;
  const tokenFactory = await hre.ethers.getContractFactory("TestContract") as TestContract__factory;
  if (hre.network.name == "bsc_testnet") {
    const pcsFactoryAddress = "0x6725F303b657a9451d8BA641348b6761A6CC7a17";
    const pcsRouterAddress = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1";
    const wbnbAddress = "0x094616F0BdFB0b526bD735Bf66Eca0Ad254ca81F";
    
    
    router = await (await upgrades.deployProxy(routerFactory, [pcsRouterAddress, pcsFactoryAddress, wbnbAddress], { kind: "uups"})).deployed() as CCMRouter;
    token = await (await tokenFactory.deploy(router.address)).deployed() as TestContract;
    console.log("Router contract at: ", router.address);
    console.log("Test contract at: ", token.address);
  } else if (hre.network.name == "bsc_mainnet") {
      token = tokenFactory.attach("0x7C23751C8CCc19D0A0a9a7f1fF52e213161118Cd") as TestContract;
      console.log("Reusing BSC Token at: ", token.address);
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
