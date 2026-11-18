import { createLoginService } from './room-login-service.js';
process.once('message', async message => {
  const result=await createLoginService().checkDouyin(message?.cookies);
  if (process.connected) process.send(result,()=>process.exit(0));
  else process.exit(0);
});
process.once('disconnect',()=>process.exit(1));
