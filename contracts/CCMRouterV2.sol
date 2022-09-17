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

contract CCMRouterV2 is TaxableRouter, UUPSUpgradeable {
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
            taxableToken[token] = false;
            IERC20(token).approve(pcsRouter, 0);
        }
    }

    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) public returns (uint[] memory amounts) {
        // We have to check if WETH is within this path.
        // If that's the case we want to (potentially) take taxes on that.
        // If we have the following path for example: CCMT => WBNB => CAKE
        // Then we may want to take out taxes for CCMT and in taxes for CAKE.
        // So what we do is to split up the token path, take the taxes and continue swapping.
        address tokenSentIn = path[0];
        address tokenTakenOut = path[path.length - 1];
        IERC20(tokenSentIn).transferFrom(msg.sender, address(this), amountIn);
        for(uint i = 0; i < path.length; ++i){
            if(taxableToken[path[i]]){
                // Token buy fees.
                if(i == 0) {
                    uint tokensToSend = takeBuyTax(path[1], path[0], amountIn);
                    IERC20(tokenSentIn).approve(pcsRouter, tokensToSend);
                    amounts = IPancakeRouter02(pcsRouter).swapExactTokensForTokens(
                        tokensToSend, amountOutMin, path, address(this), deadline);
                    amounts[0] = tokensToSend;
                }
                // Token sell fees.
                else if(i == path.length - 1) {
                    IERC20(tokenSentIn).approve(pcsRouter, amountIn);
                    amounts = IPancakeRouter02(pcsRouter).swapExactTokensForTokens(
                        amountIn, amountOutMin, path, address(this), deadline);
                    uint tokensToSend = takeSellTax(path[i - 1], path[i], amounts[amounts.length - 1]);
                    amounts[amounts.length - 1] = tokensToSend;
                }
                // Token is somewhere in between. 
                // Take out fees for the selling token and in fees for the buying token.
                else {
                    // Swap until taxable token.
                    IERC20(tokenSentIn).approve(pcsRouter, amountIn);
                    uint[] memory amountsSwapped = IPancakeRouter02(pcsRouter).swapExactTokensForTokens(
                        amountIn, amountOutMin, path[:i + 1], address(this), deadline);
                    // Take out taxes for the preceeding token and in taxes for the succeeding token.
                    uint tokensAfterSellTaxes = takeSellTax(path[i - 1], path[i], amountsSwapped[amountsSwapped.length - 1]);
                    uint tokensAfterBuyTaxes = takeBuyTax(path[i + 1], path[i], tokensAfterSellTaxes);
                    amounts = IPancakeRouter02(pcsRouter).swapExactTokensForTokens(
                        tokensAfterBuyTaxes, amountOutMin, path[i:], address(this), deadline);
                }
                require(IERC20(tokenTakenOut).transfer(to, amounts[amounts.length - 1]));
                return amounts;
            }
        }
        // If we reached this point there has not been any taxable token in the path.
        // Just call the usual API.
        IERC20(tokenSentIn).approve(pcsRouter, amountIn);
        amounts = IPancakeRouter02(pcsRouter).swapExactTokensForTokens(
            amountIn, amountOutMin, path, address(this), deadline);
        require(IERC20(path[path.length - 1]).transfer(to, amounts[amounts.length - 1]));
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