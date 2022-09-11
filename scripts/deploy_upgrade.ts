import { ethers, upgrades } from "hardhat";
import hre from "hardhat";
import { CCMRouter, CCMRouter__factory, TestContract, TestContract__factory } from "../typechain-types";

async function main() {
  // CCM router
  var router: CCMRouter;
  const routerFactory = await hre.ethers.getContractFactory("CCMRouter") as CCMRouter__factory;
  var token: TestContract;
  const tokenFactory = await hre.ethers.getContractFactory("TestContract") as TestContract__factory;
  if(hre.network.name == "bsc_testnet") {
     // Activate new proxy contract
     const proxyAddress = "0x6cE7F822075f716bdBd6A4b8aE3bA298581417ca";
     const routerFactory = await ethers.getContractFactory("CCMRouter");
     router = await upgrades.upgradeProxy(proxyAddress, routerFactory, {kind: "uups"}) as CCMRouter;
  }
  else if (hre.network.name == "bsc_mainnet") {
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
