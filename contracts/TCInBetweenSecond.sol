// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "hardhat/console.sol";
import "./TCBaseContract.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TCInBetweenSecond is TCBaseContract {

    constructor(address _router) TCBaseContract(_router){ }

    function takeTax(
        address taxableToken, address from, 
        bool isBuy, uint amount
    ) external virtual override returns(uint taxToTake){
        uint taxToTakePercent = isBuy ? 1000 : 2500;
        uint tax = amount * taxToTakePercent / 10000;
        
        return tax;
    }
}