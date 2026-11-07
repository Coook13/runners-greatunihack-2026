# Runners: three-minute in-person pitch

One speaker, approximately 140 words per minute. Pause on the bold lines and point at the corresponding evidence. The simulation supplies the numbers; do not promise a fixed result in advance.

**Runners lets delivery fleets coordinate without a central connection.**

When the phone network disappears, clinics still need their supplies. Vehicles still need to make decisions. And if food goes missing, someone still needs to establish what happened.

We built Runners to keep those operations running through disconnection.

Our first application is therapeutic food delivery. The prototype simulates twenty-nine drones, motorbikes, vans and boats on the real geography of Hawassa, Ethiopia. The roads and terrain are real. The deliveries are simulated.

On the left is a central dispatch model. On the right is Runners. Both receive the same demand.

Every Runners vehicle has an autonomous black box agent. Its objective is shared with the fleet: deliver supplies intact. Its decisions are local.

It evaluates nearby vehicles, available capacity and delivery times. If another carrier can deliver sooner, it negotiates a hand-off. The crew receives the next instruction, while the crate's contents remain sealed.

That is the first technical challenge: coordinating independent agents with incomplete information.

The second is communicating across disconnected areas.

When available, agents use the phone network. Nearby agents can exchange messages over local radio. When no connection exists, vehicles retain requests and receipts and carry them until they can forward them.

**The vehicles move both the supplies and the information needed to deliver them.**

The third challenge is accountability.

Every crate carries a digital custody passport. At each hand-off, the receiver weighs the crate and signs a receipt.

Watch what happens when we remove food. At the next weigh-in, the measurement disagrees with the passport. The system identifies the custody hop where the weight changed and names the previous holder.

That check happens locally. It does not wait for a central server.

We also restrict what each device knows. A last-mile carrier can route a crate without holding store locations, stock levels or beneficiary notes. Compromising that device gives the attacker a limited view.

When connections return, the signed records merge. An authorised auditor can open the manifest and inspect the custody history.

Our scorecard is simple: **delivered intact, losses detected and data exposed.**

Those are the outcomes we test under network failure and injected incidents.

Nothing is foolproof; we make misuse detectable and attributable.

Food delivery is our first application. The same architecture could support medicine distribution, disaster response and remote field operations.

Neptune North asked for agents that continue towards a shared goal when communication fails.

**Runners puts the decisions, communications and custody evidence inside the fleet, so the operation can continue when central communications cannot.**
