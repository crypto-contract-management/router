// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "hardhat/console.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

interface IOwnable {
    function owner() external view returns (address);
}

abstract contract TaxableRouter is OwnableUpgradeable, ReentrancyGuardUpgradeable {
    using SafeMath for uint;

    struct Tax {
        uint16 outTax;
        uint16 inTax;
        address receiver;
    }
    // Here we're saving the total taxes for a specific token.
    // That allows for fast (and cheap) tax lookup during transfers.
    struct AccumulatedTax {
        uint16 totalOutTax;
        uint16 totalInTax;
        uint accumulatedOutTax;
        uint accumulatedInTax;
        uint autoClaimAt;
        uint claimCounter;
    }

    // Taxes for plain eth transfers.
    // Each receiver can get different amount of taxes here.
    mapping(address => Tax[]) public tokenETHTaxes;
    // Accumulated token taxes.
    mapping(address => AccumulatedTax) public tokenETHTotalTaxes;
    // Wallets authorized to set fees for contracts.
    mapping(address => address) public feeOwners;

    /// @notice Modifier which only allows fee owners to change fees at all.
    /// @notice No other one (even not us) is able to set any token fees.
    /// @param token: Token of which `msg.sender` has to be the fee owner of.
    modifier byFeeOwner(address token) {
        require(msg.sender == feeOwners[token], "TCP: INVALID_FEE_OWNER");
        _;
    }

    // The taxes WE take from our clients.
    struct TokenBaseTax {
        address token;
        bool isActive;
        uint16 tax;
    }
    // Remembers if a token has been registered by its owner to activate taxing.
    mapping(address => TokenBaseTax) public tokenETHBaseTax;
    // Save how much fees this router got so far.
    uint public totalETHTaxEarned;
    /// @notice Makes sure taxes are initialized before trading is possible.
    /// @param token: Token to check if activated.
    modifier taxActive(address token) {
        require(tokenETHBaseTax[token].isActive, "TCP: TOKEN_TAX_NOT_ACTIVATED");
        _;
    }

    // Behaves like a constructor, but for upgradeables.
    function initialize() initializer internal {
        __ReentrancyGuard_init();
        __Ownable_init();
    }

    /// @notice Allows us to set a tax tier level for a certain token.
    /// @notice HOWEVER we can only make it "better".
    /// @notice So for tokens being unitialized we can set a max fee of 1%.
    /// @notice For tokens that are already initialized we can only set a lower fee than exists.
    /// @notice This is a safety measure for our clients. We don't want to harm anyone.
    /// @param token: Token to set tax tier for.
    /// @param tax: Taxes users have to pay (send to this router). Max 1% (but you can get less ;)).
    function setTaxTierLevel(address token, uint16 tax)
        external onlyOwner {
            // Max tax is 1%.
            require(tax <= 100, "TCP: SET_TAX_TIER_LEVEL_INVALID_TAX");
            TokenBaseTax memory taxEntry = tokenETHBaseTax[token];
            // If there is an entry the new tax has to be BETTER.
            require(!taxEntry.isActive || tax < taxEntry.tax, "TCP: SET_TAX_TIER_LEVEL_INVALID_TAX_UPDATE");
            tokenETHBaseTax[token] = TokenBaseTax(token, true, tax);
        }
    /// @notice Let's a fee owner choose a tier level by sending in the amount of BNB.
    /// @param token: Token to define a tax tier for.
    function chooseTaxTierLevel(address token)
     external payable byFeeOwner(token) {
        // We have a tier system here:
        // ----------------------------------------------
        // | Level      | Cost (in BNB) | Tax per trade |
        // ---------------------------------------------|
        // | Beginner   | 0             | 1%            |
        // | Apprentice | 5             | 0.5%          |
        // | Expert     | 10            | 0.3%          |
        // | Master     | ask us!       | 0%            |
        // ----------------------------------------------
        // The tier you get solely depends on the BNB you send in.
        // Your tier level CAN be changed later. Just call the method again.
        // We'll make sure that you can only upgrade e.g. not pay higher taxes than before.
        uint apprenticeFee = 5 ether;
        uint expertFee = 10 ether;
        // The BNB sent in has to be one of the levels, otherwise we reject.
        // We also only want to have that exact amount, not more, not less.
        if(msg.value == expertFee){
            tokenETHBaseTax[token] = TokenBaseTax(token, true, 30);
        } else if(msg.value == apprenticeFee){
            tokenETHBaseTax[token] = TokenBaseTax(token, true, 50);
        } else if(msg.value == 0) {
            tokenETHBaseTax[token] = TokenBaseTax(token, true, 100);
        } else {
            // No tier level selected. Reject.
            require(false, "TCP: NO_TIER_LEVEL_SELECTED");
        }
    }
    /// @notice Allows to claim taxes of a specific token.
    /// @param token: Token in question to claim taxes from.
    function claimTaxes(address token) public byFeeOwner(token){
        _claimTaxes(token);
    }
    /// @notice Does the tax claiming.
    /// @param token: Token in question to claim taxes from.
    function _claimTaxes(address token) private nonReentrant {
        // Transfer all accumulated funds accordingly.
        // Question: Isn't it dangerous to execute a `call` without a gas limit? (Reentrancy)
        // Answer: Well yes, but actually no. We have a reentrancy guard and update the state before we run the call.
        uint totalTokenETHOutTax = tokenETHTotalTaxes[token].accumulatedOutTax;
        uint totalTokenETHInTax = tokenETHTotalTaxes[token].accumulatedInTax;
        uint16 totalTokenETHTaxOutPercent = tokenETHTotalTaxes[token].totalOutTax;
        uint16 totalTokenETHTaxInPercent = tokenETHTotalTaxes[token].totalInTax;
        Tax[] memory taxReceivers = tokenETHTaxes[token];

        for(uint i = 0; i < taxReceivers.length; ++i){
            uint fundsToTransfer = 0;
            if(totalTokenETHTaxOutPercent > 0){
                uint outTaxToTransfer = totalTokenETHOutTax.mul(taxReceivers[i].outTax).div(totalTokenETHTaxOutPercent);
                fundsToTransfer = fundsToTransfer.add(outTaxToTransfer);
            }
            if(totalTokenETHTaxInPercent > 0){
                uint inTaxToTransfer = totalTokenETHInTax.mul(taxReceivers[i].inTax).div(totalTokenETHTaxInPercent);
                fundsToTransfer = fundsToTransfer.add(inTaxToTransfer);
            }
            if(fundsToTransfer > 0){
                address receiver = taxReceivers[i].receiver;
                (bool success,) = payable(receiver).call{value: fundsToTransfer}("");
                require(success, "TCP: ERROR_CLAIMING_TAX");
            }
        }
        AccumulatedTax storage accTax = tokenETHTotalTaxes[token];
        accTax.accumulatedOutTax = 0;
        accTax.accumulatedInTax = 0;
    }
    /// @notice Allows a fee owner to define auto taxing settings.
    /// @notice Passing in 0 for `autoClaimAt` effectively disables auto claiming.
    /// @notice Auto claiming can be especially usefull for auto liquidity pool filling.
    function setAutoClaimTaxes(address token, uint autoClaimAt) public byFeeOwner(token) {
        AccumulatedTax memory taxEntry = tokenETHTotalTaxes[token];
        taxEntry.autoClaimAt = autoClaimAt;
        taxEntry.claimCounter = autoClaimAt;
        tokenETHTotalTaxes[token] = taxEntry;
    }
    function _autoClaimTaxes(address token) private {
        AccumulatedTax storage taxEntry = tokenETHTotalTaxes[token];
        if(taxEntry.autoClaimAt > 0){
            taxEntry.claimCounter = taxEntry.claimCounter.sub(1);
            if(taxEntry.claimCounter == 0){
                _claimTaxes(token);
                taxEntry.claimCounter = taxEntry.autoClaimAt;
            }
        }
    }
    /// @notice Let's a token owner claim the initial fee ownership.
    /// @dev In order to make this working your token has to implement an owner() method 
    /// @dev that returns the address of the token owner.
    /// @dev After claim you can transfer the fee ownership if you like.
    /// @param token: Fee ownership to claim for token. You have to be the token owner.
    function claimInitialFeeOwnership(address token) external {
        require(feeOwners[token] == address(0x0), "TCP: FEE_OWNER_ALREADY_INITIALIZED");
        // The token owner shall have the power to claim the initial fee ownership.
        require(msg.sender == IOwnable(token).owner(), "TCP: FEE_OWNER_IS_NOT_TOKEN_OWNER");
        feeOwners[token] = msg.sender;
    }
    /// @notice Transfers fee ownership to target owner.
    /// @notice This does not transfer the receiving of fees! It only allows `newOwner` to set new fees.
    /// @notice Obviously `newOwner` can now set itself to the fee receiver, but it's not happening automatically.
    /// @param token: The token to set fees for.
    /// @param newOwner: The new fee ownership holder.
    function transferFeeOwnership(
        address token, address newOwner
    ) external byFeeOwner(token) {
        feeOwners[token] = newOwner;
    }
    /// @notice Allows a fee owner to set specific fees for a token and a receiver.
    /// @notice You are allowed to have multiple fee receivers with different taxes.
    /// @notice A common example would be an entry having a team wallet as receiver for development funds.
    /// @notice Another entry would describe the token itself as receiver to let it add liquidity when desired.
    /// @dev The receiver can be a contract which executes code after retrieval and this is intentional!
    /// @dev It allows you to add liquidity after getting BNB sent in for example.
    /// @dev You don't have to worry about OUR contract being vulnerable to reentrancy attacks - we took care of it.
    /// @param token: Token address (not pair address) for ETH fees to set.
    /// @param outTax: Tax to send to receiver during ETH out transfers. Granulariy here is to 0.01%. So min after 0% is 0.01%, max is 100.00%.
    /// @param inTax: Same as outTax but just for ETH in transfers.
    /// @param receiver: Receiver of tax fees.
    function setETHTaxes(
        address token, 
        uint16 outTax, uint16 inTax, 
        address receiver
    ) public byFeeOwner(token) {
        require(outTax <= 10000 && inTax <= 10000, "TCP: INVALID_TAX");
        uint16 totalOutTax = 0;
        uint16 totalInTax = 0;
        uint8 entryFound = 0;
        // Check if entry already exists.
        Tax[] memory memTaxes = tokenETHTaxes[token];
        for(uint i = 0; i < memTaxes.length; ++i){
            Tax memory memEntry = memTaxes[i];
            if(memEntry.receiver == receiver){
                Tax storage storageEntry = tokenETHTaxes[token][i];
                storageEntry.outTax = outTax;
                storageEntry.inTax = inTax;
                totalOutTax += outTax;
                totalInTax += inTax;
                entryFound = 1;
            } else {
                totalOutTax += memEntry.outTax;
                totalInTax += memEntry.inTax;
            }
        }
        // Not found. Add receiver tax and fully add to total tax.
        if(entryFound == 0){
            tokenETHTaxes[token].push(Tax(outTax, inTax, receiver));
            totalOutTax += outTax;
            totalInTax += inTax;
        }
        // Save total tax again.
        AccumulatedTax storage accTax = tokenETHTotalTaxes[token];
        accTax.totalInTax = totalInTax;
        accTax.totalOutTax = totalOutTax;
    }
    /// @notice Takes the ETH fee for transfers where ETH is sent IN (to the token pair).
    function takeETHInTax(
        address token, uint amountIn
    ) internal taxActive(token) returns (uint amountInLeft) {
        // Claim all in taxes for all receivers.
        uint16 taxDefinedByToken = tokenETHTotalTaxes[token].totalInTax;
        uint16 taxDefinedByRouter = tokenETHBaseTax[token].tax;
        uint taxToTakeByToken = calculateTax(taxDefinedByToken, amountIn);
        uint taxToTakeByRouter = calculateTax(taxDefinedByRouter, amountIn);
        tokenETHTotalTaxes[token].accumulatedInTax = tokenETHTotalTaxes[token].accumulatedInTax.add(taxToTakeByToken);
        totalETHTaxEarned = totalETHTaxEarned.add(taxToTakeByRouter);

        amountInLeft = amountIn.sub(taxToTakeByToken).sub(taxToTakeByRouter);
        _autoClaimTaxes(token);
    }
    /// @notice Takes the ETH fee for transfers where ETH is sent OUT (of the token pair).
    function takeETHOutTax(
        address token, uint amountOut
    ) internal taxActive(token) returns (uint amountOutLeft) {
        uint16 taxDefinedByToken = tokenETHTotalTaxes[token].totalOutTax;
        uint16 taxDefinedByRouter = tokenETHBaseTax[token].tax;
        uint taxToTakeByToken = calculateTax(taxDefinedByToken, amountOut);
        uint taxToTakeByRouter = calculateTax(taxDefinedByRouter, amountOut);
        tokenETHTotalTaxes[token].accumulatedOutTax = tokenETHTotalTaxes[token].accumulatedOutTax.add(taxToTakeByToken);
        totalETHTaxEarned = totalETHTaxEarned.add(taxToTakeByRouter);

        amountOutLeft = amountOut.sub(taxToTakeByToken).sub(taxToTakeByRouter);
        _autoClaimTaxes(token);
    }
    /// @notice Helper method to calculate the takes to take.
    /// @dev Actually we want to first multiply and then divide.
    /// @dev Reason is that division is potentially lossy when working on whole numbers.
    /// @dev For example 7 / 5 is 1.
    /// @dev Therefore first multiplying does not multiply with such a loss, hence increases accuracy.
    /// @dev But the multiplication could overflow which we don't want so we first check if that would happen
    /// @dev and if it is safe then we first multiply and then divide. Otherwise we just switch the ordering.
    function calculateTax(uint16 taxPercent, uint amount) private pure returns (uint tax) {
        if(taxPercent == 0) return 0;

        if(amount >= ~uint(0).div(taxPercent))
            tax = amount.div(10000).mul(taxPercent);
        else
            tax = amount.mul(taxPercent).div(10000);
    }
}