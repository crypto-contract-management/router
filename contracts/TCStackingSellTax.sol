// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "hardhat/console.sol";
import "./TCBaseContract.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TCSTackingSellTax is TCBaseContract {

    function takeTax(
        address taxableToken, address from, 
        bool isBuy, uint amount
    ) external virtual override returns(uint taxToTake, bool claimAfter){
        // We take sell fees for continuous sells.
        // Increase sell fee by 10% each time someone sells.
        // Reset on buy.
        uint feesToTake = amount * sellCounter * 10 / 100;
        if(isBuy){
            sellCounter = 0;
        } else {
            sellCounter += 1;
        }
        return (feesToTake, false);
    } 

}