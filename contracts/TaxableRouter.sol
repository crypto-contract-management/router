// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "hardhat/console.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

interface IOwnable {
    function owner() external view returns (address);
}

abstract contract TaxableRouter is OwnableUpgradeable, ReentrancyGuardUpgradeable {
    using SafeMath for uint;

    // The native blockchain token has no contract address (obviously).
    // We re-use the dead wallet address for that purpose.
    // We cannot use the zero address as storage can be initialized to that value.
    address constant internal ETH_ADDRESS = 0x000000000000000000000000000000000000dEaD;

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
        uint outTaxClaimable;
        uint inTaxClaimable;
        uint autoClaimAt;
        uint claimCounter;
        uint totalTaxesClaimed;
    }
    // Mapping from a user token to a taxable token to the tax receivers for that taxable token.
    // For example:
    // User token: CCMT => Taxable token: WETH.
    // Each receiver can get different amount of taxes here.
    mapping(address => mapping(address => Tax[])) public tokenTaxes;
    // Accumulated token taxes.
    mapping(address => mapping(address => AccumulatedTax)) public tokenTotalTaxes;
    // Wallets authorized to set fees for contracts.
    mapping(address => address) public feeOwners;

    /// @notice Modifier which only allows fee owners to change fees at all.
    /// @notice No other one (even not us) is able to set any token fees.
    /// @param token: Token of which `msg.sender` has to be the fee owner of.
    modifier byFeeOwner(address token) {
        require(msg.sender == feeOwners[token]);
        _;
    }

    // The taxes WE take from our clients.
    struct TokenBaseTax {
        bool isActive;
        uint16 tax;
    }
    // Remembers if a token has been registered by its owner to activate taxing.
    mapping(address => TokenBaseTax) public tokenBaseTax;
    // Save how many fees this router got so far for every token.
    mapping(address => uint) public routerTaxesEarned;
    /// @notice Makes sure taxes are initialized before trading is possible.
    /// @param token: Token to check if activated.
    modifier taxActive(address token) {
        require(tokenBaseTax[token].isActive);
        _;
    }

    // Behaves like a constructor, but for upgradeables.
    function initialize() initializer internal {
        __ReentrancyGuard_init();
        __Ownable_init();
    }

    event SetTaxTierLevel(address, uint16);
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
            require(tax <= 100, "CCM: SET_TAX_TIER_LEVEL_INVALID_TAX");
            TokenBaseTax memory taxEntry = tokenBaseTax[token];
            // If there is an entry the new tax has to be BETTER.
            require(!taxEntry.isActive || tax < taxEntry.tax, "CCM: SET_TAX_TIER_LEVEL_INVALID_TAX_UPDATE");
            tokenBaseTax[token] = TokenBaseTax(true, tax);
            emit SetTaxTierLevel(token, tax);
        }
    
    event ChoseTaxTierLevel(address, address);
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
        // We'll make sure that you can only upgrade e.g. not pay higher taxes than before, so no downgrade for you.
        uint apprenticeFee = 0.5 ether;
        uint expertFee = 1 ether;
        // The BNB sent in has to be one of the levels, otherwise we reject.
        // We also only want to have that exact amount, not more, not less.
        if(msg.value == expertFee){
            // Token must not be on expert level already
            TokenBaseTax memory existing = tokenBaseTax[token];
            require(!existing.isActive || existing.tax > 30);
            tokenBaseTax[token] = TokenBaseTax(true, 30);
        } else if(msg.value == apprenticeFee){
            // Token must not be on apprentice level or better already.
            TokenBaseTax memory existing = tokenBaseTax[token];
            require(!existing.isActive || existing.tax > 50);
            tokenBaseTax[token] = TokenBaseTax(true, 50);
        } else if(msg.value == 0) {
            // Token must not be initialized.
            TokenBaseTax memory existing = tokenBaseTax[token];
            require(!existing.isActive);
            tokenBaseTax[token] = TokenBaseTax(true, 100);
        } else {
            // No tier level selected. Reject.
            require(false, "CCM: NO_TIER_LEVEL_SELECTED");
        }
        routerTaxesEarned[ETH_ADDRESS] += msg.value;
        emit ChoseTaxTierLevel(msg.sender, token);
    }
    /// @notice Allows to claim taxes of a specific token.
    /// @param token: Token in question to claim taxes from.
    function claimTaxes(address token, address taxableToken) public byFeeOwner(token){
        _claimTaxes(token, taxableToken);
    }
    /// @notice Does the tax claiming.
    /// @param token: Token in question to claim taxes from.
    /// @param taxableToken: Token from which those taxes have actually been taken from.
    function _claimTaxes(address token, address taxableToken) private nonReentrant {
        // Transfer all accumulated funds accordingly.
        // Question: Isn't it dangerous to execute a `call` without a gas limit? (Reentrancy)
        // Answer: Well yes, but actually no. We have a reentrancy guard and update the state before we run the call.
        uint totalTokenETHOutTax = tokenTotalTaxes[token][taxableToken].outTaxClaimable;
        uint totalTokenETHInTax = tokenTotalTaxes[token][taxableToken].inTaxClaimable;
        uint16 totalTokenETHTaxOutPercent = tokenTotalTaxes[token][taxableToken].totalOutTax;
        uint16 totalTokenETHTaxInPercent = tokenTotalTaxes[token][taxableToken].totalInTax;
        Tax[] memory taxReceivers = tokenTaxes[token][taxableToken];

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
                if(taxableToken == ETH_ADDRESS){
                    (bool success,) = payable(receiver).call{value: fundsToTransfer}("");
                    require(success, "CCM: ERROR_CLAIMING_TAX");
                } else {
                    IERC20(taxableToken).transfer(receiver, fundsToTransfer);
                }
            }
        }
        AccumulatedTax storage accTax = tokenTotalTaxes[token][taxableToken];
        accTax.totalTaxesClaimed = accTax.totalTaxesClaimed.add(totalTokenETHOutTax).add(totalTokenETHInTax);
        accTax.outTaxClaimable = 0;
        accTax.inTaxClaimable = 0;
    }

    event SetAutoClaimTaxes(address, address, uint);
    /// @notice Allows a fee owner to define auto taxing settings.
    /// @notice Passing in 0 for `autoClaimAt` effectively disables auto claiming.
    /// @notice Auto claiming can be especially usefull for auto liquidity pool filling.
    function setAutoClaimTaxes(address token, address taxableToken, uint autoClaimAt) public byFeeOwner(token) {
        AccumulatedTax memory taxEntry = tokenTotalTaxes[token][taxableToken];
        taxEntry.autoClaimAt = autoClaimAt;
        taxEntry.claimCounter = autoClaimAt;
        tokenTotalTaxes[token][taxableToken] = taxEntry;
        emit SetAutoClaimTaxes(msg.sender, token, autoClaimAt);
    }
    function _autoClaimTaxes(address token, address taxableToken) private {
        AccumulatedTax storage taxEntry = tokenTotalTaxes[token][taxableToken];
        if(taxEntry.autoClaimAt > 0){
            taxEntry.claimCounter = taxEntry.claimCounter.sub(1);
            if(taxEntry.claimCounter == 0){
                _claimTaxes(token, taxableToken);
                taxEntry.claimCounter = taxEntry.autoClaimAt;
            }
        }
    }
    event ClaimedInitialFeeOwnership(address, address);
    /// @notice Let's a token owner claim the initial fee ownership.
    /// @dev In order to make this working your token has to implement an owner() method 
    /// @dev that returns the address of the token owner.
    /// @dev After claim you can transfer the fee ownership if you like.
    /// @param token: Fee ownership to claim for token. You have to be the token owner.
    function claimInitialFeeOwnership(address token) external {
        require(feeOwners[token] == address(0x0), "CCM: FEE_OWNER_ALREADY_INITIALIZED");
        // The token owner shall have the power to claim the initial fee ownership.
        require(msg.sender == IOwnable(token).owner(), "CCM: FEE_OWNER_IS_NOT_TOKEN_OWNER");
        feeOwners[token] = msg.sender;
        emit ClaimedInitialFeeOwnership(msg.sender, token);
    }
    event TransferedFeeOwnership(address, address, address);
    /// @notice Transfers fee ownership to target owner.
    /// @notice This does not transfer the receiving of fees! It only allows `newOwner` to set new fees.
    /// @notice Obviously `newOwner` can now set itself to the fee receiver, but it's not happening automatically.
    /// @param token: The token to set fees for.
    /// @param newOwner: The new fee ownership holder.
    function transferFeeOwnership(
        address token, address newOwner
    ) external byFeeOwner(token) {
        feeOwners[token] = newOwner;
        emit TransferedFeeOwnership(msg.sender, token, newOwner);
    }
    event SetTaxes(address, address, uint16, uint16, address);
    /// @notice Allows a fee owner to set specific fees for a token and a receiver.
    /// @notice You are allowed to have multiple fee receivers with different taxes.
    /// @notice A common example would be an entry having a team wallet as receiver for development funds.
    /// @notice Another entry would describe the token itself as receiver to let it add liquidity when desired.
    /// @dev The receiver can be a contract which executes code after retrieval and this is intentional!
    /// @dev It allows you to add liquidity after getting ETH sent in for example.
    /// @dev You don't have to worry about OUR contract being vulnerable to reentrancy attacks - we took care of it.
    /// @param token: Token address (not pair address) for ETH fees to set.
    /// @param outTax: Tax to send to receiver during ETH out transfers. Granulariy here is to 0.01%. So min after 0% is 0.01%, max is 100.00%.
    /// @param inTax: Same as outTax but just for ETH in transfers.
    /// @param receiver: Receiver of tax fees.
    function setTaxes(
        address token, address taxableToken,
        uint16 outTax, uint16 inTax, 
        address receiver
    ) public byFeeOwner(token) {
        require(outTax <= 10000 && inTax <= 10000, "CCM: INVALID_TAX");
        uint16 totalOutTax = 0;
        uint16 totalInTax = 0;
        uint8 entryFound = 0;
        
        Tax[] memory memTaxes = tokenTaxes[token][taxableToken];
        // Check if entry already exists.
        for(uint i = 0; i < memTaxes.length; ++i){
            Tax memory memEntry = memTaxes[i];
            // Found. Now it depends if we want to delete or update the entry.
            // On delete we subtract the old fee amount and delete the entry itself.
            if(memEntry.receiver == receiver){
                // Delete.
                if(outTax == 0 && inTax == 0){
                    AccumulatedTax storage accTaxToUpdate = tokenTotalTaxes[token][taxableToken];
                    accTaxToUpdate.totalInTax -= memEntry.inTax;
                    accTaxToUpdate.totalOutTax -= memEntry.outTax;
                    // Delete entry to gain gas back and reset the state.
                    tokenTaxes[token][taxableToken][i] = tokenTaxes[token][taxableToken][memTaxes.length - 1];
                    tokenTaxes[token][taxableToken].pop();
                    emit SetTaxes(msg.sender, token, outTax, inTax, receiver);
                    return;
                }
                Tax storage storageEntry = tokenTaxes[token][taxableToken][i];
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
        // Only if taxes are greather than 0 of course.
        if(entryFound == 0){
            tokenTaxes[token][taxableToken].push(Tax(outTax, inTax, receiver));
            totalOutTax += outTax;
            totalInTax += inTax;
        }
        // Save total tax again.
        AccumulatedTax storage accTax = tokenTotalTaxes[token][taxableToken];
        accTax.totalInTax = totalInTax;
        accTax.totalOutTax = totalOutTax;
        emit SetTaxes(msg.sender, token, outTax, inTax, receiver);
    }

    /// @notice Gives back all tax receivers for a certain token.
    /// @notice Necessary because the mapping alone does require an index for their ABI access.
    function getAllETHTaxReceivers(address token, address taxableToken) external view returns(Tax[] memory receivers){
        receivers = tokenTaxes[token][taxableToken];
    }

    /// @notice Allows the router owner to get the ETH given by for example tax tier level setup.
    /// @notice This function also ensures that the owner is NOT able to withdraw more ETH than being excessive.
    function withdrawRouterTaxes(address token) external onlyOwner {
        uint withdrawableTokens = routerTaxesEarned[token];
        routerTaxesEarned[token] = 0;
        if(withdrawableTokens > 0){ 
            if(token == TaxableRouter.ETH_ADDRESS){
                (bool success, ) = payable(owner()).call{value: withdrawableTokens}("");
                require(success);
            } else {
                require(IERC20(token).transfer(owner(), withdrawableTokens));
            }
        }
    }
    /// @notice Takes the ETH fee for transfers where ETH is sent IN (to the token pair).
    function takeInTax(
        address token, address taxableToken, uint amountIn
    ) internal taxActive(token) returns (uint amountInLeft) {
        // Claim all in taxes for all receivers.
        uint16 taxDefinedByToken = tokenTotalTaxes[token][taxableToken].totalInTax;
        uint16 taxDefinedByRouter = tokenBaseTax[token].tax;
        uint taxToTakeByToken = calculateTax(taxDefinedByToken, amountIn);
        uint taxToTakeByRouter = calculateTax(taxDefinedByRouter, amountIn);
        tokenTotalTaxes[token][taxableToken].inTaxClaimable = tokenTotalTaxes[token][taxableToken].inTaxClaimable.add(taxToTakeByToken);
        routerTaxesEarned[taxableToken] += taxToTakeByRouter;

        amountInLeft = amountIn.sub(taxToTakeByToken).sub(taxToTakeByRouter);
        _autoClaimTaxes(token, taxableToken);
    }
    /// @notice Takes the ETH fee for transfers where ETH is sent OUT (of the token pair).
    function takeOutTax(
        address token, address taxableToken, uint amountOut
    ) internal taxActive(token) returns (uint amountOutLeft) {
        uint16 taxDefinedByToken = tokenTotalTaxes[token][taxableToken].totalOutTax;
        uint16 taxDefinedByRouter = tokenBaseTax[token].tax;
        uint taxToTakeByToken = calculateTax(taxDefinedByToken, amountOut);
        uint taxToTakeByRouter = calculateTax(taxDefinedByRouter, amountOut);
        tokenTotalTaxes[token][taxableToken].outTaxClaimable = tokenTotalTaxes[token][taxableToken].outTaxClaimable.add(taxToTakeByToken);
        routerTaxesEarned[taxableToken] += taxToTakeByRouter;
        amountOutLeft = amountOut.sub(taxToTakeByToken).sub(taxToTakeByRouter);
        _autoClaimTaxes(token, taxableToken);
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