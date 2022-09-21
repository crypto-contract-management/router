TCF => WETH => TCF2 => WETH2 => TCF3;
TCF => TCF2 => WETH => TCF3;
WETH => TCF => WETH;
WETH => WETH => TCF;
TCF => WETH => WETH;
WETH => TCF => TCF2 => TCF3 => WETH2;

uint lastTaxAt = 0;
uint lastTaxAtValid = taxable[0] && !taxable[1];
for(uint i = 1; i < path.length; ++i)
    if !taxable(i-1) && taxable(i):
        if !taxable(lastTaxAt+1) && lastTaxAtValid:
            take buy fees;
        swap(path[lastTaxAt:i+1]);
        take sell fees;
    if taxable(i):
        lastTaxAt = i;
        lastTaxAtValid = true;

if lastTaxAt != path.length - 1:
    if lastTaxAtValid    
        take buy fees;
    swap(path[lastTaxAt:])