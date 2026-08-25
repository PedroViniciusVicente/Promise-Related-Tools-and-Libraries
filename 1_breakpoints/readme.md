nesta tentativa foi usado breakpoint do chrome dev tools para adicionar o breakpoint na linha 13 (que era a resolução promise2), mas descobrimos que ao chegar no breakpoint, a aplicação inteira é congelada, ou seja, a promise1 também fica congelada, fazendo com que nao tenha esse interleaving. 

npm i chrome-remote-interface
node run_with_delay.js