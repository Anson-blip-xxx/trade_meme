import {readConfig} from './config.js';
import {OrderStore} from './orders.js';

const [id]=process.argv.slice(2);
if(id&&!/^[0-9a-f-]{36}$/.test(id)) {console.error('Usage: npm run orders -- [order-id]');process.exitCode=1;}
else {
  const store=new OrderStore(readConfig().ordersDatabase);
  try {console.log(JSON.stringify(id?store.get(id)??{error:'NOT_FOUND'}:store.list(),null,2));}
  finally {store.close();}
}
