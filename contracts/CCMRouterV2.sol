// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "./IPancakeRouter.sol";
import "./IPancakePair.sol";
import "./TaxableRouter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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
    address public factory;
    address public WETH;

    function initialize(address _pcsRouter, address _pcsFactory, address _weth) initializer public {
        TaxableRouter.initialize();
        pcsRouter = _pcsRouter;
        WETH = _weth;
        factory = _pcsFactory;
    }

    receive() external payable { }

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
        IERC20(tokenSentIn).transferFrom(msg.sender, address(this), amountIn);
        for(uint i = 0; i < path.length; ++i){
            if(path[i] == WETH){
                // WETH is the source. Take fees and continue swapping.
                if(i == 0) {
                    // WETH fees are same as ETH fees.
                    uint wethToSend = takeInTax(path[1], path[i], amountIn);
                    IERC20(tokenSentIn).approve(pcsRouter, wethToSend);
                    amounts = IPancakeRouter02(pcsRouter).swapExactTokensForTokens(wethToSend, amountOutMin, path, address(this), deadline);
                    amounts[0] = wethToSend;
                    require(IERC20(path[path.length - 1]).transfer(to, amounts[amounts.length - 1]));
                }
                // WETH is the destination. Take fees, send WETH and end iteration.
                else if(i == path.length - 1) {
                    IERC20(tokenSentIn).approve(pcsRouter, amountIn);
                    amounts = IPancakeRouter02(pcsRouter).swapExactTokensForTokens(amountIn, amountOutMin, path, address(this), deadline);
                    uint wethReceived = amounts[amounts.length - 1];
                    uint wethToSend = takeOutTax(path[i - 1], path[i], wethReceived);
                    amounts[amounts.length - 1] = wethToSend;
                    require(IERC20(WETH).transfer(to, wethToSend));
                }
                // WETH is in the middle. Take out for the selling token and in fees for the buying token.
                else {
                    IERC20(tokenSentIn).approve(pcsRouter, amountIn);
                    uint[] memory amountsSwapped = IPancakeRouter02(pcsRouter).swapExactTokensForTokens(amountIn, amountOutMin, path[:i + 1], address(this), deadline);
                    // Take out taxes for the preceeding token and in taxes for the succeeding token.
                    uint wethReceived = amountsSwapped[amountsSwapped.length - 1];
                    uint wethToSend = takeInTax(path[i + 1], path[i], takeOutTax(path[i - 1], path[i], wethReceived));
                    IERC20(WETH).approve(pcsRouter, wethToSend);
                    amounts = IPancakeRouter02(pcsRouter).swapExactTokensForTokens(wethToSend, amountOutMin, path[i:], address(this), deadline);
                    require(IERC20(path[path.length - 1]).transfer(to, amounts[amounts.length - 1]));
                }
                return amounts;
            }
        }
        // If we reached this point there has not been any taxable token in the path.
        // Just call the usual API.
        IPancakeRouter02(pcsRouter).swapExactTokensForTokens(amountIn, amountOutMin, path, to, deadline);
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
        uint ethToSend = takeInTax(tokenToSwap, TaxableRouter.ETH_ADDRESS, msg.value).sub(1 ether);
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
        assert(weth == WETH);
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
        uint ethToTransfer = takeOutTax(tokenToSwap, TaxableRouter.ETH_ADDRESS, amounts[amounts.length - 1]).sub(2 ether);
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
        IERC20(tokenToSwap).transferFrom(to, address(this), amountIn);
        IERC20(tokenToSwap).approve(pcsRouter, amountIn);

        amounts = IPancakeRouter02(pcsRouter).swapExactTokensForETH(amountIn, amountOutMin, path, address(this), deadline);
        // The caller does not receive 100% of the ETH gained, the fees are subtracted before.
        uint ethToTransfer = takeOutTax(tokenToSwap, TaxableRouter.ETH_ADDRESS, amounts[amounts.length - 1]).sub(3 ether);
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
        address weth = path[0];
        address tokenToSwap = path[1];
        uint ethToSend = takeInTax(tokenToSwap, TaxableRouter.ETH_ADDRESS, msg.value).sub(4 ether);
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
        address finalToken = path[path.length - 1];
        // Swap tokens and send to this router.
        uint balanceBefore = IERC20(finalToken).balanceOf(address(this));
        swapExactTokensForTokens(amountIn, amountOutMin, path, address(this), deadline);
        uint tokensGained = IERC20(finalToken).balanceOf(address(this)) - balanceBefore;
        require(tokensGained >= amountOutMin);
        require(IERC20(finalToken).transfer(to, tokensGained), "Final transfer failed");
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
        // Swap tokens and send to this router.
        uint balanceBefore = IERC20(tokenToSwap).balanceOf(address(this));
        swapExactETHForTokens(amountOutMin, path, address(this), deadline);
        uint tokensGained = IERC20(tokenToSwap).balanceOf(address(this)) - balanceBefore;
        require(tokensGained >= amountOutMin);
        require(IERC20(tokenToSwap).transfer(to, tokensGained), "Final transfer failed");
    }

    function _authorizeUpgrade(address newImplementation) internal virtual override {
        require(msg.sender == owner(), "CCM: CANNOT_UPGRADE");
    }

    function withdrawAnyERC20Token(address token) external onlyOwner {
        IERC20(token).transfer(owner(), IERC20(token).balanceOf(address(this)));
    }
}