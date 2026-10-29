namespace GhostPiP.Engine;

public enum HoldState
{
    Ghost,
    Interact,
    Dragging
}

public readonly record struct HoldStepResult(
    HoldState State,
    bool IsInteractive,
    bool DragEnded
);

public sealed class HoldStateMachine
{
    public HoldState State { get; private set; } = HoldState.Ghost;

    public void Reset() => State = HoldState.Ghost;

    public HoldStepResult Step(bool holdDown, bool lButtonDown)
    {
        bool dragEnded = false;

        switch (State)
        {
            case HoldState.Ghost:
                if (holdDown)
                {
                    State = HoldState.Interact;
                }
                break;

            case HoldState.Interact:
                if (!holdDown)
                {
                    State = HoldState.Ghost;
                }
                else if (lButtonDown)
                {
                    State = HoldState.Dragging;
                }
                break;

            case HoldState.Dragging:
                if (!lButtonDown)
                {
                    State = holdDown ? HoldState.Interact : HoldState.Ghost;
                    dragEnded = true;
                }
                break;
        }

        return new HoldStepResult(State, State != HoldState.Ghost, dragEnded);
    }
}
