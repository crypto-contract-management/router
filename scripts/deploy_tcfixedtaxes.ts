import { ethers, upgrades } from "hardhat";
import hre from "hardhat";
import { CCMRouter, CCMRouter__factory, TCFixedTaxes, TCFixedTaxes__factory } from "../typechain-types";

async function main() {
  // CCM router
  var router: CCMRouter;
  const routerFactory = await hre.ethers.getContractFactory("CCMRouter") as CCMRouter__factory;
  var token: TCFixedTaxes;
  const tokenFactory = await hre.ethers.getContractFactory("TCFixedTaxes") as TCFixedTaxes__factory;
  if (hre.network.name == "bsc_testnet") {
    const routerAddress = "0xC5779647b53eECccd9e1179b999d76BdCfaB483E"
    token = await (await tokenFactory.deploy(routerAddress)).deployed() as TCFixedTaxes;
    console.log("Test contract at: ", token.address);
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
