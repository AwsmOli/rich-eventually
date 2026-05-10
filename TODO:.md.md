TODO: 


Techstack

Typescript
VueJS
Pug
Scss 
https://www.npmjs.com/package/@evespace/esi-client



I want to build an application that gets market data from the EvE Online API via the ESI client to show arbitrage opportunities 

in a list it should show Items that i can buy cheap in one station and sell for a higher price in another
it need to show how many jumps are between stations and show the squares with the sec status color for each jump 
best would be to show it on a 2d map similar to the ingame map

the rows should show the best sell and the best buy price for the item in the sell station and calculate the profit, the investment needed, the cargohold space needed, and the profit/jump similar to https://www.eve-trading.net/

clicking the item or station name should copy the name so i can easly paste them into the games UI 

We need to make sure to respect any rate limit on the API

there needs to be filters so filter by from and to system, max cargohold, max investment, max jumps, and route security - also need to be able to add systems to avoid on routes 
also needs to be able to apply the sales tax per accounting level to the profit calculation 


Make sure the code is nice and clean, no inline css, no !important, no any, calculations and viewmodels in services that are singelton typescript files that export an instance of the service - dumb single file vue components with setup script that just show data provided by properties - with some smart components that use the services to get the data 