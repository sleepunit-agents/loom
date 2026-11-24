import assert from 'node:assert/strict';

export async function householdAgentOwners({app,page,tile}) {
  const db=app.services.comms.db.$client;
  const agents=db.prepare('SELECT id FROM agents WHERE removed_at IS NULL ORDER BY id').all();
  const members=app.services.household.members();
  const cards=tile.locator('article').filter({has:page.locator('form[aria-label^="Save appearance for "]')});
  assert.ok(agents.length>0);
  assert.equal(await cards.count(),agents.length);
  for(const {id} of agents){
    const owners=members.filter(member=>member.agents.includes(id)).map(member=>member.id);
    const card=cards.filter({has:page.getByRole('heading',{name:id,exact:true})});
    await card.getByText(owners.length?'Owned by '+owners.join(', '):'No assigned owner',{exact:true}).waitFor();
  }
  return {ok:true,reason:'Each active agent appeared in Household setup with its assigned household members.'};
}
