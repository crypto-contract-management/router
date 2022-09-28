// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "hardhat/console.sol";
import "./TCBaseContract.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TCStackingSellTax is TCBaseContract {

    address immutable public feeReceiver;

    constructor(address _router, address _feeReceiver) TCBaseContract(_router){
        feeReceiver = _feeReceiver;
    }

    function onTaxClaimed(address taxableToken, uint amount) external virtual override {
        require(IERC20(taxableToken).transfer(feeReceiver, amount));
    }

    function takeTax(
        address taxableToken, address from, 
        bool isBuy, uint amount
    ) external virtual override returns(uint taxToTake){
        // We take sell fees for continuous sells.
        // Increase sell fee by 10% each time someone sells.
        // Reset on buy.
        if(isBuy){
            sellCounter = 0;
        } else {
            sellCounter += 1;
        }
        uint feesToTake = amount * sellCounter * 10 / 100;
        return feesToTake;
    } 

}