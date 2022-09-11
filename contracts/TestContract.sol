// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "hardhat/console.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TestContract is ERC20 {

    mapping(address => uint8) private isPair;
    mapping(address => uint8) public isExcluded;

    address public owner;

    constructor(address _router) ERC20("TestContract", "TC") {
        owner = msg.sender;
        _mint(msg.sender, 1_000_000 * 10**18);
        isExcluded[msg.sender] = 1;
        isExcluded[_router] = 1;
    }

    function setIsPair(address pair, uint8 _isPair) public {
        isPair[pair] = _isPair;
    }

    event TokenTransfer(address, address, uint256);
    function _beforeTokenTransfer(address from, address to, uint256 amount)
        internal virtual override // Add virtual here!
    {
        // If a pair is part of a token transfer the sender or taget has to be the router.
        // That ensures we're always able to take fees on the router.
        if(isExcluded[from] == 0 && isExcluded[to] == 0){
            require(isPair[from] == 0 && isPair[to] == 0, "TCP: Router required");
        }
        emit TokenTransfer(from, to, amount);
    }
}