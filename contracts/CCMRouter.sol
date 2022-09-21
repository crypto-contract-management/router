// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "./IPancakeRouter.sol";
import "./IPancakePair.sol";
import "./TaxableRouter.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

library TransferHelper {
    function safeTransfer(address token, address to, uint value) internal {
        // bytes4(keccak256(bytes('transfer(address,uint256)')));
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), 'TransferHelper: TRANSFER_FAILED');
    }

    function safeTransferFrom(address token, address from, address to, uint value) internal {
        // bytes4(keccak256(bytes('transferFrom(address,address,uint256)')));
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), 'TransferHelper: TRANSFER_FROM_FAILED');
    }

    function safeTransferETH(address to, uint value) internal {
        (bool success,) = to.call{value:value}(new bytes(0));
        require(success, 'TransferHelper: ETH_TRANSFER_FAILED');
    }
}

contract CCMRouter is TaxableRouter, UUPSUpgradeable {
    using SafeMath for uint;

    address public pcsRouter;
    address public WETH;
    // List of taxable tokens.
    // For now: WETH.
    mapping(address => bool) public taxableToken;

    function initialize(address _pcsRouter, address _weth) initializer public {
        TaxableRouter.initialize();
        pcsRouter = _pcsRouter;
        WETH = _weth;
        setTaxableToken(_weth, true);
    }

    receive() external payable { }


    /// @notice Sets a taxable IERC20 token and potentially allows all routers to spend this token.
    /// @param token Token to tax
    function setTaxableToken(address token, bool isTaxable) public onlyOwner {
        if(isTaxable){
            taxableToken[token] = true;
            IERC20(token).approve(pcsRouter, ~uint(0));
        } else {
            taxableToken[token] = true;
            IERC20(token).approve(pcsRouter, uint(0));
        }
        
    }

/*
TCF => WETH => TCF2 => WETH2 => TCF3;
TCF => TCF2 => WETH => TCF3;
WETH => TCF => WETH;
WETH => WETH2 => TCF;
TCF => WETH => WETH2;
TCF => WETH => WETH2 => WETH3 => TCF2 => WETH4;
WETH => TCF => TCF2 => TCF3 => WETH2;
WETH => WETH2 => WETH3;

uint lastTaxAt = 0;
uint lastTaxAtValid = taxable[0] && !taxable[1];
for(uint i = 1; i < path.length; ++i)
    if taxable(i):
        if !taxable(i-1):
            if !taxable(lastTaxAt+1) && lastTaxAtValid:
                take buy fees;
            swap(path[lastTaxAt:i+1]);
            take sell fees;
        lastTaxAt = i;
        lastTaxAtValid = true;

if lastTaxAt != path.length - 1:
    if lastTaxAtValid    
        take buy fees;
    swap(path[lastTaxAt:])
*/

    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) public returns (uint[] memory amounts) {
        amounts = new uint[](path.length);
        uint lastTaxTakenAt = 0;
        uint lastTaxableTokenAt = 0;
        bool taxTakenValid  = taxableToken[path[0]] && !taxableToken[path[1]];
        uint amountToSwap = amountIn;
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountToSwap);
        for(uint i = 1; i < path.length - 1; ++i){
            // It's a sell. We only take (buy and sell) taxes when sold.
            // This saves gas.
            if(taxableToken[path[i]]){
                if(!taxableToken[path[i - 1]]){

                    // If there has been a chain of taxable tokens
                    // we need to swap those at first to be able to take buy taxes.
                    if(lastTaxTakenAt != lastTaxableTokenAt){
                        IERC20(path[lastTaxTakenAt]).approve(pcsRouter, amountToSwap);
                        uint[] memory swappedAmounts = IPancakeRouter02(pcsRouter).swapExactTokensForTokens(
                            amountToSwap, 0, path[lastTaxTakenAt: lastTaxableTokenAt + 1], address(this), deadline);
                        // Save correct amounts.
                        amounts[lastTaxTakenAt] = amountToSwap;
                        for(uint swapPathIter = 1; swapPathIter < swappedAmounts.length - 1; ++swapPathIter)
                            amounts[lastTaxTakenAt + swapPathIter] = swappedAmounts[swapPathIter];
                        
                        amountToSwap = swappedAmounts[swappedAmounts.length - 1];
                        lastTaxTakenAt = lastTaxableTokenAt;
                    }
                    // First we need to process the remaining buy taxes.
                    if(!taxableToken[path[lastTaxTakenAt + 1]] && taxTakenValid)
                        amountToSwap = takeBuyTax(path[lastTaxTakenAt + 1], path[lastTaxTakenAt], amountToSwap);
                    if(!taxableToken[path[lastTaxTakenAt]])
                        IERC20(path[lastTaxTakenAt]).approve(pcsRouter, amountToSwap);
                    uint[] memory swappedAmounts = IPancakeRouter02(pcsRouter).swapExactTokensForTokens(
                        amountToSwap, 0, path[lastTaxTakenAt: i + 1], address(this), deadline);
                    // Save correct amounts.
                    amounts[lastTaxTakenAt] = amountToSwap;
                    for(uint swapPathIter = 1; swapPathIter < swappedAmounts.length - 2; ++swapPathIter)
                        amounts[lastTaxTakenAt + swapPathIter] = swappedAmounts[swapPathIter];
                    // Now take sell taxes and save remaining tokens to swap.
                    amountToSwap = takeSellTax(path[i - 1], path[i], swappedAmounts[swappedAmounts.length - 1]);
                    amounts[lastTaxTakenAt + swappedAmounts.length - 1] = amountToSwap;
                    lastTaxTakenAt = i;
                    taxTakenValid = true;
                }
                lastTaxableTokenAt = i;
            }
        }
        // To keep return values right we have to 
        // It can be the case that we never sold a token before,
        // or that there are simply no taxable tokens in the path.
        // Or there is a buy pending since we only take tax and execute swapping for token selling.
        // In either case we need to transfer the remaining tokens appropriately.
        if(lastTaxTakenAt != path.length - 1){
            // If there has been a chain of taxable tokens
            // we need to swap those at first to be able to take buy taxes.
            if(lastTaxTakenAt != lastTaxableTokenAt){
                uint[] memory swappedAmounts = IPancakeRouter02(pcsRouter).swapExactTokensForTokens(
                    amountToSwap, 0, path[lastTaxTakenAt: lastTaxableTokenAt + 1], address(this), deadline);
                // Save correct amounts.
                for(uint swapPathIter = 0; swapPathIter < swappedAmounts.length - 1; ++swapPathIter)
                    amounts[lastTaxTakenAt + swapPathIter] = swappedAmounts[swapPathIter];
                
                amountToSwap = swappedAmounts[swappedAmounts.length - 1];
                lastTaxTakenAt = lastTaxableTokenAt;
            }
            if (taxTakenValid)
                amountToSwap = takeBuyTax(path[lastTaxTakenAt + 1], path[lastTaxTakenAt], amountToSwap);

            if(!taxableToken[path[lastTaxTakenAt]])
                IERC20(path[lastTaxTakenAt]).approve(pcsRouter, amountToSwap);
            
            uint[] memory swappedAmounts = IPancakeRouter02(pcsRouter).swapExactTokensForTokens(
                amountToSwap, 0, path[lastTaxTakenAt:], address(this), deadline);
            // Save last bit of swapped amounts in total amounts array.
            for(uint swapPathIter = 0; swapPathIter < swappedAmounts.length; ++swapPathIter)
                amounts[lastTaxTakenAt + swapPathIter] = swappedAmounts[swapPathIter];
            // Transfer the remaining tokens.
            require(IERC20(path[path.length - 1]).transfer(to, amounts[amounts.length - 1]));
        }
    }
    function swapTokensForExactTokens(
        uint amountOut,
        uint amountInMax,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts) {
        require(false, "Coming soon!");
    }
    function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline)
        public
        virtual
        payable
        returns (uint[] memory amounts)
    {
        address tokenToSwap = path[1];
        uint ethToSend = takeBuyTax(tokenToSwap, TaxableRouter.ETH_ADDRESS, msg.value);
        // Swap tokens and send to this router.
        amounts = IPancakeRouter02(pcsRouter).swapExactETHForTokens{value: ethToSend}(amountOutMin, path, address(this), deadline);
        require(IERC20(tokenToSwap).transfer(to, amounts[amounts.length - 1]));
    }
    function swapTokensForExactETH(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline)
        external
        virtual
        returns (uint[] memory amounts)
    {
        address tokenToSwap = path[0];
        address weth = path[path.length - 1];
        // Transfer tokens from caller to this router and then swap these tokens via PCS.
        // Save BNB balance before and after to know how much BNB to send the caller after swapping.
        uint tokensNeeded = IPancakeRouter02(pcsRouter).getAmountsIn(amountOut, path)[0];
        require(tokensNeeded <= amountInMax, 'CCM: NOT_ENOUGH_OUT_FOR_IN');
        TransferHelper.safeTransferFrom(
            tokenToSwap, msg.sender, address(this), tokensNeeded
        );
        IERC20(tokenToSwap).approve(pcsRouter, tokensNeeded);
        amounts = IPancakeRouter02(pcsRouter).swapTokensForExactETH(amountOut, amountInMax, path, address(this), deadline);
        // The caller does not receive 100% of the ETH gained, the fees are subtracted before.
        uint ethToTransfer = takeSellTax(
            tokenToSwap, TaxableRouter.ETH_ADDRESS,
            amounts[amounts.length - 1]);
        // Now send to the caller.
        TransferHelper.safeTransferETH(to, ethToTransfer);
    }
    function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)
        public
        virtual
        returns (uint[] memory amounts)
    {
        address tokenToSwap = path[0];
        address weth = path[path.length - 1];
        assert(weth == WETH);
        // Transfer tokens from caller to this router and then swap these tokens via PCS.
        // Save BNB balance before and after to know how much BNB to send the caller after swapping.
        IERC20(tokenToSwap).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenToSwap).approve(pcsRouter, amountIn);
        amounts = IPancakeRouter02(pcsRouter).swapExactTokensForETH(amountIn, amountOutMin, path, address(this), deadline);
        // The caller does not receive 100% of the ETH gained, the fees are subtracted before.
        uint ethToTransfer = takeSellTax(
            tokenToSwap, TaxableRouter.ETH_ADDRESS, 
            amounts[amounts.length - 1]);
        // Now send to the caller.
        TransferHelper.safeTransferETH(to, ethToTransfer);
    }
    function swapETHForExactTokens(uint amountOut, address[] calldata path, address to, uint deadline)
        external
        virtual
        payable
        returns (uint[] memory amounts)
    {
        // We only work with taxes between direct pairs of WETH <=> Token for now.
        address tokenToSwap = path[1];
        uint ethToSend = takeBuyTax(tokenToSwap, TaxableRouter.ETH_ADDRESS, msg.value);
        // Swap tokens and send to this router.
        amounts = IPancakeRouter02(pcsRouter).swapETHForExactTokens{value: ethToSend}(amountOut, path, address(this), deadline);
        require(IERC20(tokenToSwap).transfer(to, amounts[amounts.length - 1]), "Final transfer failed");
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external virtual {
        uint[] memory amounts = swapExactTokensForTokens(amountIn, amountOutMin, path, address(this), deadline);
        uint tokensToSend = amounts[amounts.length - 1];
        require(tokensToSend >= amountOutMin, "CCM: LESS_OUT");
        require(IERC20(path[path.length - 1]).transfer(to, tokensToSend), "Final transfer failed");
    }
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    )
        external
        virtual
        payable
    {
        address tokenToSwap = path[1];
        uint[] memory amounts = swapExactETHForTokens(amountOutMin, path, address(this), deadline);
        uint tokensToSend = amounts[amounts.length - 1];
        require(tokensToSend >= amountOutMin, "CCM: LESS_OUT");
        require(IERC20(tokenToSwap).transfer(to, tokensToSend), "Final transfer failed");
    }
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    )
        external
        virtual
    {
        uint[] memory amounts = swapExactTokensForETH(amountIn, amountOutMin, path, address(this), deadline);
        uint tokensToSend = amounts[amounts.length - 1];
        require(tokensToSend >= amountOutMin, "CCM: LESS_OUT");
        TransferHelper.safeTransferETH(to, tokensToSend);
    }

    function _authorizeUpgrade(address newImplementation) internal virtual override {
        require(msg.sender == owner(), "CCM: CANNOT_UPGRADE");
    }

    function withdrawAnyERC20Token(address token) external onlyOwner {
        IERC20(token).transfer(owner(), IERC20(token).balanceOf(address(this)));
    }
}