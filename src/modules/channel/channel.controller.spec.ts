import { ChannelController } from './channel.controller';
import { ChannelService } from './channel.service';

describe('ChannelController.getMessages limit parsing', () => {
  const build = () => {
    const service = { getChannelMessages: jest.fn().mockResolvedValue([]) };
    const controller = new ChannelController(service as unknown as ChannelService);
    return { controller, service };
  };

  it('falls back to the engine default (undefined) when ?limit is not numeric — never forwards NaN', async () => {
    const { controller, service } = build();
    await controller.getMessages('s1', 'ch1@newsletter', 'abc');
    expect(service.getChannelMessages).toHaveBeenCalledWith('s1', 'ch1@newsletter', undefined);
  });

  it('forwards a valid numeric limit unchanged', async () => {
    const { controller, service } = build();
    await controller.getMessages('s1', 'ch1@newsletter', '25');
    expect(service.getChannelMessages).toHaveBeenCalledWith('s1', 'ch1@newsletter', 25);
  });

  it('forwards undefined when ?limit is omitted (engine default)', async () => {
    const { controller, service } = build();
    await controller.getMessages('s1', 'ch1@newsletter', undefined);
    expect(service.getChannelMessages).toHaveBeenCalledWith('s1', 'ch1@newsletter', undefined);
  });
});

describe('ChannelController.demoteAdmin', () => {
  it('forwards the path params and the body field in the right order', async () => {
    // The argument order is the whole risk here: sessionId, channelId and userId are all strings,
    // so a swap compiles, type-checks and would demote the wrong party in the wrong channel.
    const service = { demoteChannelAdmin: jest.fn().mockResolvedValue(undefined) };
    const controller = new ChannelController(service as unknown as ChannelService);
    await expect(controller.demoteAdmin('s1', 'ch1@newsletter', { userId: '628@c.us' })).resolves.toEqual({
      success: true,
    });
    expect(service.demoteChannelAdmin).toHaveBeenCalledWith('s1', 'ch1@newsletter', '628@c.us');
  });

  it('lets an engine refusal propagate instead of answering success', async () => {
    const service = { demoteChannelAdmin: jest.fn().mockRejectedValue(new Error('refused')) };
    const controller = new ChannelController(service as unknown as ChannelService);
    await expect(controller.demoteAdmin('s1', 'ch1@newsletter', { userId: '628@c.us' })).rejects.toThrow('refused');
  });
});
