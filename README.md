# Router project of the CryptoContractManagement

Allows users to get fees for their tokens pairs without token selling!
Essentially getting the liquidity you desire without requiring to hurt your charts.

Supported chains/tokens:

- BSC
  - WETH

# Include CCM into your project

This describes the steps a contract developer has to take to actually make use of our economy:

- Make sure all pair transactions are going through our router (check our very own contract for a glimpse)
- Use our dashboard to claim your initial token tax ownership (requires your token to implement IOwnable and you to hold the private keys to the owner's wallet)
- Choose a tax tier level via our dashboard. We take taxes based upon your level:
  - Beginner: Free, 1% taxes taken for every taxable transfer
  - Apprentice: 5 BNB fee, only 0.5% taxes taken for every taxable transfer
  - Expert: 10 BNB fee, only 0.3% taxes taken for every taxable transfer
  - Master: ???, reach out to us - we find a deal!
